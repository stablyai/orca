import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { assertLegacyAiVaultResumeCommandAllowed } from './structured-session-ownership'
import { installOwnership, PROVIDER_SESSION } from './structured-session-ownership.test-support'

const OPENCODE_ID = 'ses_2f9aB3cD4eF5gH6iJ7kL8mN9oP'
const UUID = '019fd622-3c4d-7e5f-a061-7c8d9e0f1a2b'
const OTHER_UUID = '019fd633-4d5e-7f60-b172-8d9e0f1a2b3c'
const PI_FILE = `/Users/me/.pi/agent/sessions/--Users-me-repo--/2026-10-09T10-00-00-000Z_${UUID}.jsonl`

type Agent = {
  name: string
  own: () => void
  /** A resume of the owned conversation, without its program. */
  resumeArgs: string
  /** `--flag=` forms, each completed by a quoted target. */
  inlineFlags: string[]
  otherId: string
}

const acp = (agent: 'opencode' | 'grok' | 'omp', nativeId: string): AgentSessionProviderHandle => ({
  transport: 'acp',
  agent,
  nativeId
})

const AGENTS: Agent[] = [
  {
    name: 'claude',
    own: () => installOwnership({ provider: 'claude' }),
    resumeArgs: `-r ${PROVIDER_SESSION}`,
    inlineFlags: ['--resume=', '-r='],
    otherId: OTHER_UUID
  },
  {
    name: 'codex',
    own: () => installOwnership(),
    resumeArgs: `resume ${PROVIDER_SESSION}`,
    inlineFlags: [],
    otherId: OTHER_UUID
  },
  {
    name: 'opencode',
    own: () => installOwnership({ handle: acp('opencode', OPENCODE_ID) }),
    resumeArgs: `-s ${OPENCODE_ID}`,
    inlineFlags: ['--session=', '-s='],
    otherId: 'ses_other'
  },
  {
    name: 'grok',
    own: () => installOwnership({ handle: acp('grok', UUID) }),
    resumeArgs: `-r ${UUID}`,
    inlineFlags: ['--resume=', '-r=', '--load='],
    otherId: OTHER_UUID
  },
  {
    name: 'omp',
    own: () => installOwnership({ handle: acp('omp', UUID) }),
    resumeArgs: `--resume ${UUID}`,
    inlineFlags: ['--resume=', '-r=', '--session='],
    otherId: OTHER_UUID
  },
  {
    name: 'pi',
    own: () =>
      installOwnership({ handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: PI_FILE } }),
    resumeArgs: `--session ${UUID}`,
    inlineFlags: ['--session='],
    otherId: OTHER_UUID
  }
]

const allowed = (command: string) =>
  expect(
    assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined),
    command
  ).resolves.toBeUndefined()
const refused = (command: string) =>
  expect(
    assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined),
    command
  ).rejects.toThrow('agent_session_conflict')

function ownedId(agent: Agent): string {
  return agent.resumeArgs.split(' ').at(-1)!
}

afterEach(() => setStructuredAgentSessionHost(null))

describe.each(AGENTS)('a $name resume read as a shell reads it', (agent) => {
  const resume = `${agent.name} ${agent.resumeArgs}`

  it('ends at a separator glued to a word', async () => {
    agent.own()
    for (const command of [
      `${resume}; echo done`,
      `${resume};`,
      `${resume}|tee x`,
      `${resume}&`,
      `${resume}&&echo done`,
      `cd /x&&${resume}`,
      `cd /x||${resume}`,
      `cd /x;${resume}`,
      `cd /x|${resume}`,
      `echo hi 2>&1;${resume} 2>&1`
    ]) {
      await refused(command)
    }
  })

  it('keeps a quoted separator inside its word', async () => {
    agent.own()
    await refused(`${agent.name} "a;b" 'c|d' ${agent.resumeArgs}`)
    await allowed(`echo "x;${resume}" 'y&&${resume}'`)
  })

  it('removes the quotes around a value after `=`', async () => {
    agent.own()
    for (const flag of agent.inlineFlags) {
      await refused(`${agent.name} ${flag}"${ownedId(agent)}"`)
      await refused(`${agent.name} ${flag}'${ownedId(agent)}'`)
      await allowed(`${agent.name} ${flag}"${agent.otherId}"`)
    }
  })
})

// Agent names count only where the shell would run them, including text sent from agent prompts.
describe.each(AGENTS)('a $name resume in command position', (agent) => {
  const resume = `${agent.name} ${agent.resumeArgs}`

  it('is refused behind assignments, a path or a launcher', async () => {
    agent.own()
    for (const command of [
      `FOO=1 BAR='a b' ${resume}`,
      `/usr/local/bin/${resume}`,
      `${agent.name[0]!.toUpperCase()}${agent.name.slice(1)} ${agent.resumeArgs}`,
      `env -i FOO=1 ${resume}`,
      `exec ${resume}`,
      `command ${resume}`,
      `sudo -E ${resume}`,
      `npx ${resume}`,
      `bunx ${resume}`,
      `pnpm dlx ${resume}`,
      `& 'C:\\Program Files\\${agent.name}\\${agent.name}.exe' ${agent.resumeArgs}`,
      `cd /d "C:/x" && ${resume}`,
      `echo hi\n${resume}`
    ]) {
      await refused(command)
    }
  })

  it('is allowed as another program’s argument or prompt text', async () => {
    agent.own()
    for (const command of [
      `Fix the ${agent.name} ${agent.resumeArgs} handling`,
      `echo ${resume}`,
      `git commit -m wip ${resume}`,
      `rg -n ${resume}`
    ]) {
      await allowed(command)
    }
  })
})

it('allows a prompt that names a Pi flag while a Pi chat owns a conversation', async () => {
  AGENTS.find(({ name }) => name === 'pi')!.own()
  await allowed('Fix the Pi --resume flag')
  await allowed('The pi -c path is broken.\nPlease fix pi --continue too')
})
