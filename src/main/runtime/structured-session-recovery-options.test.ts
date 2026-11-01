import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { OPENCODE_TRANSCRIPT_IMPORT } from '../opencode/opencode-transcript-import'
import { CLAUDE_CLI_CONVERSATIONS } from '../claude/claude-cli-conversations'
import { PI_TRANSCRIPT_IMPORT } from '../pi/pi-transcript-import'
import { PI_SESSION_HISTORY } from '../pi/pi-session-history'
import {
  structuredSessionRecoveryOptions,
  type RecoveryContextCache
} from './structured-session-recovery-options'

const homes = vi.hoisted((): { paths: string[] } => ({ paths: [] }))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({ accountSelectionHomes: async () => homes.paths })
}))
vi.mock('./structured-agent-runtime-metadata', () => ({
  structuredAgentRuntimeMetadata: (provider: string) => ({
    ...CLAUDE_CLI_CONVERSATIONS,
    ...(provider === 'opencode' ? { transcriptImport: OPENCODE_TRANSCRIPT_IMPORT } : {}),
    ...(provider === 'pi'
      ? { transcriptImport: PI_TRANSCRIPT_IMPORT, sessionHistory: PI_SESSION_HISTORY }
      : {}),
    launchFollowsSelection: () => true
  })
}))

it('offers switching only when the real transcript store is shared with every destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-limit-actions-'))
  try {
    const system = join(root, 'default'),
      account = join(root, 'account'),
      isolated = join(root, 'isolated')
    const projects = join(system, 'projects')
    await mkdir(join(projects, 'workspace'), { recursive: true })
    await mkdir(account)
    await mkdir(join(isolated, 'projects', 'workspace'), { recursive: true })
    await symlink(
      projects,
      join(account, 'projects'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const transcript = join(projects, 'workspace', 'provider-session-alpha-1.jsonl')
    await writeFile(transcript, '{}\n')
    const record = agentSessionRecordFixture()
    record.accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: account }
    homes.paths = [system, account]
    const cache: RecoveryContextCache = {}
    const importer = CLAUDE_CLI_CONVERSATIONS.transcriptImport
    if (!importer) {
      throw new Error('Missing transcript importer')
    }
    const locate = vi.spyOn(importer, 'findTranscript')
    const read = () => structuredSessionRecoveryOptions(record, {}, { cache })
    expect((await Promise.all([read(), read()]))[0]).toMatchObject({
      canSwitchAccount: true,
      transcriptPath: expect.any(String)
    })
    expect(locate).toHaveBeenCalledTimes(1)
    await read()
    expect(locate).toHaveBeenCalledTimes(1)
    homes.paths = [system, isolated]
    expect((await read()).canSwitchAccount).toBe(false)
    expect(locate).toHaveBeenCalledTimes(1)
    await rm(transcript)
    expect(await read()).toEqual({ canSwitchAccount: false })
    await writeFile(transcript, '{}\n')
    expect((await read()).transcriptPath).toBeTruthy()
    locate.mockRestore()
    homes.paths = [system, account]
    const privateTranscript = join(
      isolated,
      'projects',
      'workspace',
      'provider-session-alpha-1.jsonl'
    )
    await writeFile(privateTranscript, '{}\n')
    record.accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: isolated }
    expect(await read()).toEqual({
      canSwitchAccount: false,
      transcriptPath: await realpath(privateTranscript)
    })
    record.accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: account }
    homes.paths.push(isolated)
    expect((await read()).canSwitchAccount).toBe(false)
    homes.paths = [system, join(root, 'unverified')]
    expect((await read()).canSwitchAccount).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('offers direct Pi history only while its admitted native file exists, retrying missing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-limit-actions-pi-'))
  const store = vi.spyOn(PI_TRANSCRIPT_IMPORT, 'conversationStore').mockReturnValue(root)
  try {
    const transcript = join(root, 'missing.jsonl')
    const record = agentSessionRecordFixture()
    record.provider = 'pi'
    record.accountHome = { variable: 'PI_CODING_AGENT_DIR', path: root }
    record.providerHandleChain[0].handle = {
      transport: 'pi-rpc',
      agent: 'pi',
      nativeId: transcript
    }
    const cache: RecoveryContextCache = {}
    const read = () => structuredSessionRecoveryOptions(record, {}, { cache })
    expect(await read()).toEqual({ canSwitchAccount: false })
    await writeFile(transcript, '{}\n')
    const available = { canSwitchAccount: false, transcriptPath: await realpath(transcript) }
    expect(await read()).toEqual(available)
    await rm(transcript)
    expect(await read()).toEqual({ canSwitchAccount: false })
    await writeFile(transcript, '{}\n')
    expect(await read()).toEqual(available)
  } finally {
    store.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('leaves database-backed context to recent chat messages without locating or exposing a database', async () => {
  const record = agentSessionRecordFixture()
  record.provider = 'opencode'
  const store = vi.spyOn(OPENCODE_TRANSCRIPT_IMPORT, 'conversationStore')
  const locate = vi.spyOn(OPENCODE_TRANSCRIPT_IMPORT, 'findTranscript')
  const resolveWorkspacePath = vi.fn(async () => '/workspace')
  try {
    expect(
      await structuredSessionRecoveryOptions(record, {}, { cache: {}, resolveWorkspacePath })
    ).toEqual({
      canSwitchAccount: false
    })
    expect(store).not.toHaveBeenCalled()
    expect(locate).not.toHaveBeenCalled()
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
  } finally {
    store.mockRestore()
    locate.mockRestore()
  }
})
