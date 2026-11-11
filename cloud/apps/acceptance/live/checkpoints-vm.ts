// Live proof on a real dev VM (no model spend): per-turn code checkpoints in an Orca Cloud workspace.
// A real Claude Code chat runs in orcad on the VM, with its model pointed at a stand-in on the VM
// (standin-anthropic.py), and the desktop's own E2EE request connection and client capabilities.
//   1. Each message that opens a turn writes one refs/orca/checkpoints/<chat>/turn/* ref; the user's
//      HEAD, staged files and stash list never change.
//   2. Sleep (suspend) and wake (resume): the refs and files are unchanged. A fresh connection, as a
//      restarted desktop has, rewinds the chat to turn B and restores its files; Undo brings them back.
//   3. Rollover (host replaced): the refs are still there, a new turn gets its own ref, and the agent's
//      context holds only the turns left after the rewind.
//   4. Restart (orcad restarted): rewind to turn A restores the files from before the first turn.
// Dev backends only. The VM is always deleted at the end unless --keep is given.
// Run from the repo root after `pnpm install` there and in cloud/:
//   node_modules/.bin/tsx cloud/apps/acceptance/live/checkpoints-vm.ts [--keep]
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { control, vercel } from '../src/clients'
import { RemoteRuntimeRequestConnection } from '../../../../src/shared/remote-runtime/requests/remote-runtime-request-connection'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../src/shared/electron-remote-runtime-client-capabilities'
import { pairedRuntimeConnectionFromOffer } from '../../../../src/shared/remote-runtime/pairing/paired-runtime-connection'
import { parsePairingCode } from '../../../../src/shared/remote-runtime/pairing/pairing'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../../../src/shared/agent-session/structured-agent-session-create'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../../src/shared/agent-session/lifecycle/structured-agent-session-mutation'
import { structuredAgentSessionMessageSendMutation } from '../../../../src/shared/agent-session/requests/structured-agent-session-send-mutation'
import { agentJournalSubmissionKey } from '../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionHistoryResult } from '../../../../src/shared/agent-session/agent-session-wire'
import type {
  AgentSessionCheckpointPreview,
  AgentSessionCheckpointRestoreResult
} from '../../../../src/shared/agent-session/lifecycle/agent-session-checkpoint'

const REPO = '/vercel/sandbox/ckvm-repo'
const STANDIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'standin-anthropic.py')
const MODEL = 'claude-sonnet-4-5-20250929'
const who = { sub: `ckvm-${Date.now().toString(36)}` }
const keep = process.argv.includes('--keep')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const since = (t0: number) => Math.round(performance.now() - t0)
type Files = Record<string, string>
type Vm = { id: string; vsession: string; pairingCode: string }

const timings: Record<string, number> = {}
const failures: string[] = []
function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`)
}
function check(ok: boolean, what: string): void {
  log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) {
    failures.push(what)
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function exec(vm: Vm, script: string, timeoutMs = 120_000): Promise<string> {
  const r = await vercel().runCommand(vm.vsession, { command: 'bash', args: ['-lc', script], timeoutMs })
  if (r.exitCode !== 0) {
    throw new Error(`VM command exited ${r.exitCode}: ${r.stderr.slice(-1500)}`)
  }
  return r.stdout
}

/** Every file in the repo except .git and .claude, with its content, as the user sees it. */
async function files(vm: Vm): Promise<Files> {
  const out = await exec(
    vm,
    `cd ${REPO} && find . \\( -name .git -o -name .claude \\) -prune -o -type f -print | sort | while read -r f; do printf '%s\\t%s\\n' "\${f#./}" "$(base64 -w0 < "$f")"; done`
  )
  const result: Files = {}
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, b64] = line.split('\t')
    result[name!] = Buffer.from(b64 ?? '', 'base64').toString('utf8')
  }
  return result
}
const refs = async (vm: Vm) =>
  (await exec(vm, `cd ${REPO} && git for-each-ref --format='%(refname) %(objectname)' refs/orca/`)).trim().split('\n').filter(Boolean)
const turnRefs = async (vm: Vm) => (await refs(vm)).filter((ref) => ref.includes('/turn/'))
/** HEAD, staged paths, stash count: what checkpoints must never touch. */
const userGit = (vm: Vm) =>
  exec(vm, `cd ${REPO} && git rev-parse HEAD && git diff --cached --name-only && git stash list | wc -l`).then((s) => s.trim())

/** The desktop's own paired request connection and client capabilities (E2EE WebSocket to orcad). */
function connect(vm: Vm) {
  const offer = parsePairingCode(vm.pairingCode)
  if (!offer) {
    throw new Error('the control plane returned an unreadable pairing code')
  }
  const connection = new RemoteRuntimeRequestConnection(
    pairedRuntimeConnectionFromOffer(offer),
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  const raw = async <T>(method: string, params: unknown, timeoutMs = 60_000) => {
    const response = await connection.request<T>(method, params, timeoutMs)
    if (response.ok === false) {
      throw new Error(`${method}: ${response.error.message} ${JSON.stringify(response.error.data ?? null)}`)
    }
    return response
  }
  const call = async <T>(method: string, params: unknown, timeoutMs?: number) => (await raw<T>(method, params, timeoutMs)).result
  return { raw, call, close: () => connection.close() }
}
type Client = ReturnType<typeof connect>

const tail = (client: Client, sessionId: string) =>
  client.call<AgentSessionHistoryResult>('agentSession.history', { sessionId, direction: 'tail', limit: 200 })

async function startStandin(vm: Vm): Promise<void> {
  const source = readFileSync(STANDIN).toString('base64')
  await exec(vm, `echo ${source} | base64 -d > /tmp/standin.py; pkill -f '^python3 /tmp/standin[.]py' || true`)
  // Detached: a runCommand's process tree ends with the call.
  await vercel().startCommand(vm.vsession, { command: 'python3', args: ['/tmp/standin.py'], timeoutMs: 30 * 60_000 })
  const code = await exec(
    vm,
    `for i in $(seq 1 20); do c=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:8998/v1/models); [ "$c" = 200 ] && break; sleep 0.5; done; echo $c`
  )
  if (code.trim() !== '200') {
    throw new Error(`stand-in model server did not start (${code.trim()})`)
  }
}

async function lifecycle(vm: Vm, action: 'resume' | 'rollover' | 'restart'): Promise<void> {
  const t0 = performance.now()
  const r = await control.as(who, 'POST', `/v1/sandboxes/${vm.id}/${action}`)
  if (r.status !== 200) {
    throw new Error(`${action} -> ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`)
  }
  timings[action] = since(t0)
  vm.vsession = r.body.sandbox.session.id
  vm.pairingCode = r.body.connection.pairingCode
  log(`${action}: 200 in ${timings[action]} ms`)
  await startStandin(vm)
}

const TURNS: Record<string, string> = {
  A: "printf 'one\\n' > feature.txt",
  B: "printf 'v2\\n' > app.txt && rm feature.txt && mkdir -p notes && printf 'later\\n' > notes/todo.txt",
  C: "printf 'three\\n' > three.txt && printf 'v3\\n' > app.txt",
  D: "printf 'after-rewind\\n' > d.txt",
  E: "printf 'e\\n' > e.txt"
}
type Turn = { itemId: string; before: Files; after: Files }

/** Sends one message and waits until the agent replied and the chat has gone quiet. */
async function turn(vm: Vm, client: Client, sessionId: string, name: string): Promise<Turn> {
  const before = await files(vm)
  const refsBefore = (await turnRefs(vm)).length
  const clientOperationId = createStructuredAgentSessionOperationId(randomUUID)
  const page = (await tail(client, sessionId)).page
  await client.call(
    'agentSession.send',
    structuredAgentSessionMessageSendMutation({
      sessionId,
      clientOperationId,
      expectedRuntimeFence: page.fence ?? 0,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `Turn ${name}. RUN: ${TURNS[name]}` }] },
      delivery: 'queue-if-active'
    }),
    120_000
  )
  const itemId = agentJournalSubmissionKey(clientOperationId)
  let last = -1
  let quiet = 0
  for (let i = 0; i < 150; i++) {
    await sleep(2000)
    const items = (await tail(client, sessionId)).page.items
    const index = items.findIndex((item) => item.itemId === itemId)
    const replied =
      index !== -1 && items.slice(index + 1).some((item) => item.body.kind === 'message' && item.body.role === 'assistant')
    const newest = items.at(-1)?.sequence ?? -1
    quiet = newest === last ? quiet + 1 : 0
    last = newest
    if (replied && quiet >= 3) {
      break
    }
  }
  const after = await files(vm)
  check((await turnRefs(vm)).length === refsBefore + 1, `turn ${name} wrote one checkpoint ref (${refsBefore} -> ${refsBefore + 1})`)
  check(!same(before, after), `turn ${name}: the agent changed files`)
  return { itemId, before, after }
}

/** The "Turn X." markers in the context of the model request that ran this turn's command. */
async function modelContext(vm: Vm, name: string): Promise<string> {
  const lines = (await exec(vm, 'cat /tmp/standin.log')).split('\n')
  const line = lines.reverse().find((l) => l.includes(`-> tool ${TURNS[name]!.slice(0, 40)}`))
  return /context=(\[[^\]]*\])/.exec(line ?? '')?.[1] ?? 'none'
}

async function rewindAndRestore(vm: Vm, client: Client, sessionId: string, name: string, t: Turn, undo: boolean) {
  const items = (await tail(client, sessionId)).page.items
  check(items.some((item) => item.itemId === t.itemId), `fresh connection: turn ${name}'s message is in the chat (${items.length} items)`)
  let t0 = performance.now()
  const preview = await client.call<AgentSessionCheckpointPreview>('agentSession.checkpointPreview', { sessionId, itemId: t.itemId })
  timings[`preview${name}`] = since(t0)
  log(`preview ${name}: ${JSON.stringify(preview)}`)
  check(preview.available && !preview.busy && !preview.headMoved, `turn ${name} has a restorable checkpoint`)
  const filesBefore = await files(vm)
  // As the UI does: rewind the chat first, then restore the files.
  let rewound = ''
  for (let i = 0; i < 40 && !rewound.includes('"ok":true'); i++) {
    const page = (await tail(client, sessionId)).page
    const fields = { itemId: t.itemId, expectedEpoch: page.epoch }
    const response = await client.raw('agentSession.rewind', {
      ...fields,
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
        expectedRuntimeFence: page.fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({ method: 'agentSession.rewind', sessionId, fields })
      }
    }, 200_000)
    rewound = JSON.stringify(response.result)
    if (!rewound.includes('"ok":true')) {
      await sleep(5000)
    }
  }
  const after = (await tail(client, sessionId)).page.items
  check(
    rewound.includes('"ok":true') && !after.some((item) => item.itemId === t.itemId),
    `rewind ${name}: the chat drops the message and everything after it (${items.length} -> ${after.length} items)`
  )
  let restored: AgentSessionCheckpointRestoreResult | undefined
  t0 = performance.now()
  for (let i = 0; i < 30 && !restored; i++) {
    try {
      restored = await client.call<AgentSessionCheckpointRestoreResult>('agentSession.checkpointRestore', { sessionId, itemId: t.itemId }, 120_000)
    } catch (error) {
      if (!String(error).includes('busy')) {
        throw error
      }
      await sleep(2000)
    }
  }
  timings[`restore${name}`] = since(t0)
  const now = await files(vm)
  check(same(now, t.before), `restore ${name}: files are exactly as when turn ${name} was sent (${restored?.changedFiles} changed)`)
  if (undo && restored) {
    t0 = performance.now()
    await client.call('agentSession.checkpointUndo', { sessionId, undoId: restored.undoId }, 120_000)
    timings[`undo${name}`] = since(t0)
    check(same(await files(vm), filesBefore), `undo ${name}: the agent's later edits are back`)
  }
}

async function main(): Promise<void> {
  let t0 = performance.now()
  const created = await control.as(who, 'POST', '/v1/sandboxes', { machineSize: 'standard', workspaceId: 'ckvm' })
  if (created.status !== 200) {
    throw new Error(`create -> ${created.status} ${JSON.stringify(created.body)}`)
  }
  timings.create = since(t0)
  const vm: Vm = {
    id: created.body.sandbox.id,
    vsession: created.body.sandbox.session.id,
    pairingCode: created.body.connection.pairingCode
  }
  log(`create: ${vm.id} (${who.sub}) in ${timings.create} ms, region ${created.body.sandbox.region}`)
  try {
    await startStandin(vm)
    const settingsEnv = Buffer.from(JSON.stringify({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8998',
      ANTHROPIC_AUTH_TOKEN: 'standin-no-cost',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
      NO_PROXY: '127.0.0.1,localhost',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    })).toString('base64')
    // Claude Code applies settings.json env over its inherited env: its model is the stand-in.
    const setup = await exec(vm, `set -e
f="$HOME/.claude/settings.json"; mkdir -p "$(dirname "$f")"; [ -f "$f" ] || echo '{}' > "$f"
python3 -c 'import json,sys,base64; f=sys.argv[1]; d=json.load(open(f)); d.setdefault("env",{}).update(json.loads(base64.b64decode(sys.argv[2]))); json.dump(d,open(f,"w"))' "$f" ${settingsEnv}
claude --version; cat /opt/orca/runtime/orcad/SOURCE_COMMIT
rm -rf ${REPO}; mkdir -p ${REPO}; cd ${REPO}; git init -q; git config user.name E2E; git config user.email e2e@example.test
printf 'build/\\n' > .gitignore; printf 'v0\\n' > app.txt; git add .; git -c commit.gpgsign=false commit -qm base
printf 'staged by the user\\n' > staged.txt; git add staged.txt`)
    log(`VM: ${setup.trim().replace(/\n/g, ', ')}`)
    const gitAtStart = await userGit(vm)

    let client = connect(vm)
    const added = await client.call<{ repo: { id: string } }>('repo.add', { path: REPO })
    let worktreeId = ''
    for (let i = 0; i < 30 && !worktreeId; i++) {
      worktreeId = (await client.call<{ worktrees: { id: string }[] }>('worktree.list', { repo: `id:${added.repo.id}` })).worktrees[0]?.id ?? ''
      if (!worktreeId) {
        await sleep(1000)
      }
    }
    const sessionId = createStructuredAgentSessionId('claude', randomUUID)
    await client.call('agentSession.create', structuredAgentSessionCreateParams({
      sessionId,
      worktree: `id:${worktreeId}`,
      agent: 'claude',
      options: { permissionMode: 'full-access' },
      randomUuid: randomUUID
    }))
    for (let i = 0; i < 60 && !(await tail(client, sessionId)).page.fence; i++) {
      await sleep(2000)
    }
    const runtimeAtStart = (await client.raw('agentSession.history', { sessionId, direction: 'tail', limit: 1 }))._meta.runtimeId

    // 1. One checkpoint per turn; the user's git state untouched.
    const turns: Record<string, Turn> = {}
    for (const name of ['A', 'B', 'C']) {
      turns[name] = await turn(vm, client, sessionId, name)
    }
    check((await userGit(vm)) === gitAtStart, 'HEAD, staged files and stash list unchanged by snapshots')
    client.close()

    // 2. Sleep and wake, then a fresh connection (a restarted desktop) rewinds to B and restores.
    const refsBeforeSleep = await refs(vm)
    const filesBeforeSleep = await files(vm)
    t0 = performance.now()
    const suspended = await control.as(who, 'POST', `/v1/sandboxes/${vm.id}/suspend`)
    timings.suspend = since(t0)
    check(suspended.status === 200 && suspended.body.sandbox.status === 'suspended', `suspend -> ${suspended.body?.sandbox?.status} in ${timings.suspend} ms`)
    await lifecycle(vm, 'resume')
    check(same(await refs(vm), refsBeforeSleep), `after sleep and wake: all ${refsBeforeSleep.length} checkpoint refs are unchanged`)
    check(same(await files(vm), filesBeforeSleep), 'after sleep and wake: files unchanged')
    client = connect(vm)
    await rewindAndRestore(vm, client, sessionId, 'B', turns.B!, true)
    check((await userGit(vm)) === gitAtStart, 'after restore and undo: HEAD, staged files and stash list unchanged')
    client.close()

    // 3. Rollover: refs survive a new host; a new turn checkpoints; the agent only sees A and D.
    const refsBeforeRollover = await refs(vm)
    await lifecycle(vm, 'rollover')
    check(same(await refs(vm), refsBeforeRollover), `after rollover: all ${refsBeforeRollover.length} refs (turn and undo) are unchanged`)
    client = connect(vm)
    turns.D = await turn(vm, client, sessionId, 'D')
    const contextD = await modelContext(vm, 'D')
    check(contextD === "['A', 'D']", `after rewind to B, the agent's context holds only A and D (${contextD})`)
    client.close()

    // 4. Restart orcad, then a fresh connection rewinds to the first turn.
    await lifecycle(vm, 'restart')
    client = connect(vm)
    const runtimeNow = (await client.raw('agentSession.history', { sessionId, direction: 'tail', limit: 1 }))._meta.runtimeId
    check(runtimeNow !== runtimeAtStart, `orcad is a new process (runtime ${runtimeAtStart.slice(0, 8)} -> ${runtimeNow.slice(0, 8)})`)
    await rewindAndRestore(vm, client, sessionId, 'A', turns.A!, false)
    turns.E = await turn(vm, client, sessionId, 'E')
    const contextE = await modelContext(vm, 'E')
    check(contextE === "['E']", `after rewind to A, the agent's context holds only E (${contextE})`)
    check((await userGit(vm)) === gitAtStart, 'end: HEAD, staged files and stash list unchanged')
    client.close()
    log(`refs at the end:\n${(await refs(vm)).join('\n')}`)
  } finally {
    if (keep) {
      log(`--keep: ${vm.id} left running for ${who.sub}`)
    } else {
      const deleted = await control.as(who, 'DELETE', `/v1/sandboxes/${vm.id}`)
      const listed = await control.as(who, 'GET', '/v1/sandboxes')
      log(`delete ${vm.id}: ${deleted.status} ${deleted.body?.sandbox?.status}; sandboxes left: ${JSON.stringify(listed.body?.sandboxes?.map((s: { id: string; status: string }) => [s.id, s.status]) ?? [])}`)
    }
  }
}

main().then(
  () => {
    log(`timings (ms): ${JSON.stringify(timings)}`)
    log(failures.length ? `FAILED ${failures.length}: ${failures.join('; ')}` : 'checkpoints-vm OK')
    process.exit(failures.length ? 1 : 0)
  },
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
