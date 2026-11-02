import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CLAUDE_CLI_CONVERSATIONS } from '../claude/claude-cli-conversations'
import { resolveStructuredAgentSessionAdoptionForCreate } from '../runtime/structured-agent-session-create-adoption'
import { structuredAgentCliSourcePath } from './structured-agent-cli-source'
import { prepareAdoptedTranscript } from './agent-session-wire/structured-agent-session-adopted-import'
import type { AgentSessionAttachParams } from './agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import { prepareLegacyTranscriptImport } from './agent-session-journal/journal-legacy-import'
import { prepareCodexAdoption } from './codex-adoption-preparation'
import { codexAiVaultSessionResumePreparation } from '../codex/codex-ai-vault-session-resume'
import * as codexHomes from '../codex/codex-home-paths'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-source-admission-')))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
const id = 'provider-session'
async function file(path: string, records: unknown[]) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return path
}
function params(agent: StructuredAgentId, transcriptPath: string): AgentSessionAttachParams {
  return {
    envelope: { sessionId: 'new-chat', clientOperationId: 'create', expectedRuntimeFence: null, payloadFingerprint: '' },
    location: { executionHostId: 'local', workspaceId: 'folder', workspaceKind: 'folder', wslDistro: null },
    agent, provider: agent, runtimeKind: 'native', accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root },
    adopt: { providerHandle: { agent, transport: 'terminal-transcript', nativeId: id }, transcriptPath,
      source: { providerSessionId: id, workspaceCwd: root } }
  }
}

it('creates from the host hook path when Claude filename differs, then checks actual recorded cwd', async () => {
  const transcriptPath = await file(join(root, 'projects', 'folder', 'different-uuid.jsonl'), [
    { type: 'user', uuid: 'first', sessionId: id, cwd: root, message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'reply', sessionId: id, cwd: '/later-drift', message: { role: 'assistant', content: 'reply' } }
  ])
  const sourcePath = () => structuredAgentCliSourcePath({
    agent: 'claude', workspaceId: 'folder', resumeFrom: { providerSessionId: id,
      cliSource: { workspaceId: 'folder', paneKey: 'tab:leaf' } },
    rows: [{ paneKey: 'tab:leaf', worktreeId: 'folder', agentType: 'claude', state: 'waiting', prompt: '',
      connectionId: null, receivedAt: 1, stateStartedAt: 1,
      providerSession: { key: 'session_id', id, transcriptPath } }]
  })
  const importer = CLAUDE_CLI_CONVERSATIONS.transcriptImport!
  const selectedAccountHome = { variable: 'CLAUDE_CONFIG_DIR', path: root }
  vi.spyOn(importer, 'accountHomeCandidates').mockReturnValue([
    selectedAccountHome, { ...selectedAccountHome, path: join(root, 'locked-account') }
  ])
  const admit = importer.admitTranscriptPath.bind(importer)
  const admission = vi.spyOn(importer, 'admitTranscriptPath').mockImplementation((args) => {
    if (args.store !== join(root, 'projects')) {
      throw Object.assign(new Error('Account inaccessible'), { code: 'EACCES' })
    }
    return admit(args)
  })
  const find = vi.spyOn(importer, 'findTranscript')
  const adoption = await resolveStructuredAgentSessionAdoptionForCreate({
    settings: {}, agent: 'claude', transcriptImport: importer, providerSessionId: id,
    selectedAccountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root },
    launchEnv: {}, workspaceCwd: root, resolveTranscriptPath: sourcePath
  })
  expect(adoption.transcriptPath).toBe(transcriptPath)
  expect(admission).toHaveBeenCalledOnce()
  expect(find).not.toHaveBeenCalled()
  expect(await prepareAdoptedTranscript(params('claude', adoption.transcriptPath))).toMatchObject({ ok: true })
  const wrongDirectory = params('claude', adoption.transcriptPath)
  if (wrongDirectory.adopt?.source) {
    wrongDirectory.adopt.source.workspaceCwd = '/another-folder'
  }
  expect(await prepareAdoptedTranscript(wrongDirectory)).toMatchObject({ ok: false,
    refusal: { details: { reason: 'transcriptUnreadable' } } })

  const foreign = await file(join(root, 'foreign.jsonl'), [])
  const escaped = process.platform === 'win32' ? foreign : join(root, 'projects', 'escaped.jsonl')
  if (process.platform !== 'win32') {
    await symlink(foreign, escaped)
  }
  await expect(resolveStructuredAgentSessionAdoptionForCreate({
    settings: {}, agent: 'claude', transcriptImport: importer, providerSessionId: id,
    selectedAccountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root },
    launchEnv: {}, workspaceCwd: root, resolveTranscriptPath: () => escaped
  })).rejects.toMatchObject({ refusal: { details: { reason: 'transcriptUnreadable' } } })
  admission.mockRejectedValueOnce(Object.assign(new Error('Selected account inaccessible'), { code: 'EACCES' }))
  await expect(resolveStructuredAgentSessionAdoptionForCreate({
    settings: {}, agent: 'claude', transcriptImport: importer, providerSessionId: id,
    selectedAccountHome, launchEnv: {}, workspaceCwd: root, resolveTranscriptPath: sourcePath
  })).rejects.toMatchObject({ refusal: { details: { reason: 'transcriptUnreadable' } } })
  expect(find).not.toHaveBeenCalled()
})

it('judges the lookup and its re-admission against one store resolved once per account', async () => {
  const transcriptPath = await file(join(root, 'projects', 'folder', `${id}.jsonl`), [])
  const importer = CLAUDE_CLI_CONVERSATIONS.transcriptImport!
  const selectedAccountHome = { variable: 'CLAUDE_CONFIG_DIR', path: root }
  vi.spyOn(importer, 'accountHomeCandidates').mockReturnValue([selectedAccountHome])
  const store = vi.spyOn(importer, 'conversationStore')
  const find = vi.spyOn(importer, 'findTranscript')
  const admission = vi.spyOn(importer, 'admitTranscriptPath')
  const adoption = await resolveStructuredAgentSessionAdoptionForCreate({
    settings: {}, agent: 'claude', transcriptImport: importer, providerSessionId: id,
    selectedAccountHome, launchEnv: {}, workspaceCwd: root
  })
  expect(adoption.transcriptPath).toBe(transcriptPath)
  expect(store).toHaveBeenCalledOnce()
  expect(find.mock.calls[0]?.[0].store).toBe(join(root, 'projects'))
  expect(admission.mock.calls[0]?.[0].store).toBe(join(root, 'projects'))
})

it.skipIf(process.platform === 'win32')('reports a not-yet-saved conversation under a linked account folder as unsaved', async () => {
  const linked = join(root, 'linked-account')
  await mkdir(join(root, 'projects'), { recursive: true })
  await symlink(root, linked)
  await expect(resolveStructuredAgentSessionAdoptionForCreate({
    settings: {}, agent: 'claude', transcriptImport: CLAUDE_CLI_CONVERSATIONS.transcriptImport!,
    providerSessionId: id, selectedAccountHome: { variable: 'CLAUDE_CONFIG_DIR', path: linked },
    launchEnv: {}, workspaceCwd: root,
    resolveTranscriptPath: () => join(linked, 'projects', 'folder', `${id}.jsonl`)
  })).rejects.toMatchObject({ refusal: { details: { reason: 'transcriptNotFound' } } })
})

it.each(['claude', 'codex', 'grok', 'omp', 'pi'] as const)('retains empty versus unreadable source facts for %s', async (agent) => {
  const transcript = join(root, `${id}.jsonl`)
  await writeFile(transcript, '')
  expect(await prepareAdoptedTranscript(params(agent, transcript))).toMatchObject({ ok: false,
    refusal: { details: { reason: 'transcriptNotFound' } } })
  for (const content of ['{broken json}\n', '{"type":"future_record"}\n']) {
    await writeFile(transcript, content)
    expect(await prepareAdoptedTranscript(params(agent, transcript))).toMatchObject({ ok: false,
      refusal: { details: { reason: 'transcriptUnreadable' } } })
  }
})

it('checks canonical provider metadata during the existing import, including Codex copied parent metadata', async () => {
  const codex = await file(join(root, `${id}.jsonl`), [
    { type: 'session_meta', payload: { id } },
    { type: 'session_meta', payload: { id: 'copied-parent' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'hello' } }
  ])
  expect(await prepareAdoptedTranscript(params('codex', codex))).toMatchObject({ ok: true })
  for (const agent of ['omp', 'pi'] as const) {
    const transcript = await file(join(root, `${id}.jsonl`), [
      { type: 'session', id, cwd: root },
      { type: 'message', id: 'turn', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }
    ])
    expect(await prepareAdoptedTranscript(params(agent, transcript))).toMatchObject({ ok: true })
    await file(transcript, [{ type: 'session', id: 'foreign', cwd: root }])
    expect(await prepareAdoptedTranscript(params(agent, transcript))).toMatchObject({ ok: false })
  }
  const grok = await file(join(root, id, 'chat_history.jsonl'), [{ type: 'user', content: 'hello' }])
  await file(join(root, id, 'summary.json'), [{ info: { id, cwd: root } }])
  expect(await prepareAdoptedTranscript(params('grok', grok))).toMatchObject({ ok: true })
  await rm(join(root, id, 'summary.json'))
  expect(await prepareAdoptedTranscript(params('grok', grok))).toMatchObject({ ok: false,
    refusal: { details: { reason: 'transcriptUnreadable' } } })
  await file(codex, [{ type: 'session_meta', payload: { id } }])
  expect(await prepareLegacyTranscriptImport({ agent: 'codex', sessionId: id,
    options: { filePath: codex } })).toMatchObject({ ok: true, items: [], sourceEmpty: false })
  expect(await prepareAdoptedTranscript(params('codex', codex))).toMatchObject({ ok: false,
    refusal: { details: { reason: 'transcriptUnreadable' } } })
})

it('materializes legacy Codex into the system home and pins a verified selected account alias', async () => {
  const legacy = codexHomes.getOrcaManagedCodexHomePath()
  const system = join(root, 'system')
  const historyOnly = join(root, 'history-only')
  const selected = join(root, 'codex-accounts', 'selected', 'home')
  const suffix = join('sessions', '2026', '10', '15', `rollout-stamp-${id}.jsonl`)
  const transcriptPath = await file(join(legacy, suffix), [{ type: 'session_meta', payload: { id } }])
  vi.spyOn(codexHomes, 'getSystemCodexHomePath').mockReturnValue(system)
  const source = { accountHome: { variable: 'CODEX_HOME' as const, path: legacy }, transcriptPath }
  const prepare = codexAiVaultSessionResumePreparation(() => ({
    runtimeHome: {
      isHostSystemDefaultRealHomeSelected: () => true,
      resolveSelectedHostAccountCodexHomePathForResume: () => null,
      getHostCodexHomePathsForSessionDiscovery: () => [legacy]
    },
    systemCodexHomePath: historyOnly, preparePinnedLaunchHome: async () => {}
  }))
  const migrated = await prepareCodexAdoption(source, id, prepare, [source.accountHome])
  expect(migrated).toEqual({ accountHome: { variable: 'CODEX_HOME', path: system }, transcriptPath: join(system, suffix) })
  await expect(prepareLegacyTranscriptImport({ agent: 'codex', sessionId: id,
    options: { filePath: join(historyOnly, suffix) } })).resolves.toMatchObject({ ok: false })
  await prepare({ agent: 'codex', sessionId: id, filePath: transcriptPath, codexHome: legacy, executionHostId: 'local' })
  expect(await prepareLegacyTranscriptImport({ agent: 'codex', sessionId: id,
    options: { filePath: join(historyOnly, suffix) } })).toMatchObject({ ok: true })
  await file(join(selected, suffix), [{ type: 'session_meta', payload: { id } }])
  expect(await prepareCodexAdoption(migrated, id, async () => ({ useRealCodexHome: false, substituteCodexHome: selected }),
    [{ variable: 'CODEX_HOME', path: selected }])).toEqual({ accountHome: { variable: 'CODEX_HOME', path: selected }, transcriptPath: join(selected, suffix) })
  await expect(prepareCodexAdoption(source, id, async () => { throw new Error('EACCES selected account') },
    [source.accountHome])).rejects.toThrow('EACCES selected account')
})
