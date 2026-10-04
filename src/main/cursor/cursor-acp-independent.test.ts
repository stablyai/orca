import { cursorAcpFixtureLaunch } from './cursor-acp-protocol-fixture'
import { expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { CursorAcpJournal } from './cursor-acp-journal'
import { CursorAcpPrompts } from './cursor-acp-prompts'
import { createCursorAcpSession } from './cursor-acp-session'
import { openCursorAcpConnection, type CursorAcpConnection } from './cursor-acp-connection'

it.each(['completed', 'failed'] as const)(
  'preserves %s tool status when a partial update omits status',
  (state) => {
    const bodies: AgentJournalItemBody[] = []
    const journal = new CursorAcpJournal(() => 'private-review', {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => {},
      publish: () => {}
    })
    journal.update(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'private-tool',
        title: 'Private tool',
        status: state,
        rawInput: { value: 1 }
      },
      false
    )
    journal.update(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'private-tool',
        rawOutput: 'additional output'
      },
      false
    )
    expect(bodies.at(-1)).toMatchObject({ kind: 'tool-call', state })
  }
)

it('preserves tool data when an ACP partial update supplies null input and output', () => {
  const bodies: AgentJournalItemBody[] = []
  const journal = new CursorAcpJournal(() => 'private-review', {
    appendItem: (_identity, body) => bodies.push(body),
    appendTombstone: () => {},
    publish: () => {}
  })
  journal.update(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'private-tool',
      title: 'Private tool',
      status: 'completed',
      rawInput: { value: 1 },
      rawOutput: 'saved output'
    },
    false
  )
  expect(() =>
    journal.update(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'private-tool',
        rawInput: null,
        rawOutput: null
      },
      false
    )
  ).not.toThrow()
  expect(bodies.at(-1)).toMatchObject({
    kind: 'tool-call',
    state: 'completed',
    input: { value: 1 },
    output: { head: '"saved output"' }
  })
})

const provider = String.raw`
const readline=require('node:readline')
const send=frame=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n')
let pending;let cancelled=false
readline.createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line)
 if(frame.method==='initialize')return send({id:frame.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}})
 if(frame.method==='session/new')return send({id:frame.id,result:{sessionId:'private-review'}})
 if(frame.method==='session/prompt'){
  pending=frame
  return send({id:'private-permission',method:'session/request_permission',params:{sessionId:'private-review',toolCall:{toolCallId:'private-tool'},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'}]}})
 }
 if(frame.method==='session/cancel'){cancelled=true;return}
 if(frame.id==='private-permission'&&frame.result?.outcome?.outcome==='cancelled'&&cancelled){
  return send({id:pending.id,result:{stopReason:'cancelled'}})
 }
})
`

it('settles Stop while an ACP-compliant provider waits for a cancelled permission response', async () => {
  let transport: CursorAcpConnection | undefined
  let count = 0
  const prompts = new CursorAcpPrompts(
    () => {
      if (!transport) {
        throw new Error('missing connection')
      }
      return transport
    },
    () => 'private-review',
    () => {
      count++
    }
  )
  const session = await createCursorAcpSession({
    launch: { command: process.execPath, args: ['-e', provider] },
    cwd: tmpdir(),
    openConnection: async (launch, handlers) => {
      transport = await openCursorAcpConnection(launch, handlers)
      return transport
    },
    events: {
      update: () => {},
      request: (request) => {
        prompts.receive(request)
      }
    }
  })
  const pending = session.prompt([{ type: 'text', text: 'private fixture' }])
  void pending.catch(() => {})
  try {
    const deadline = Date.now() + 1000
    while (count === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(count).toBe(1)
    expect(await session.cancel(150)).toBe(true)
    expect(await pending).toBe('cancelled')
  } finally {
    await session.close()
    prompts.clear()
  }
})

it('keeps a permission-blocked turn occupied after an unresponsive provider receives cancellation', async () => {
  let transport: CursorAcpConnection | undefined
  let count = 0
  const prompts = new CursorAcpPrompts(
    () => {
      if (!transport) {
        throw new Error('missing connection')
      }
      return transport
    },
    () => 'fixture-conversation-1',
    () => {
      count++
    }
  )
  const session = await createCursorAcpSession({
    launch: cursorAcpFixtureLaunch({ FIXTURE_IGNORE_CANCEL: '1' }),
    cwd: tmpdir(),
    openConnection: async (launch, handlers) => {
      transport = await openCursorAcpConnection(launch, handlers)
      return transport
    },
    events: {
      update: () => {},
      request: (request) => {
        prompts.receive(request)
      }
    }
  })
  const pending = session.prompt([{ type: 'text', text: 'approval' }])
  void pending.catch(() => {})
  try {
    await vi.waitFor(() => expect(count).toBe(1))
    await expect(session.cancel(50)).rejects.toThrow('did not confirm cancellation')
    expect(count).toBe(2)
    expect(session.phase).toBe('cancelling')
    expect(() => session.prompt([{ type: 'text', text: 'overlap' }])).toThrow('another prompt')
    await expect(session.cancel(20)).rejects.toThrow('did not confirm cancellation')
    expect(count).toBe(2)
  } finally {
    await session.close()
    prompts.clear()
    await expect(pending).rejects.toThrow()
  }
})
