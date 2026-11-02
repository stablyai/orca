import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { parseAgentSessionFile } from '../ai-vault/session-scanner-agent-parser'
import { AI_VAULT_AGENT_SOURCES } from '../ai-vault/session-scanner-agent-sources'
import { discoverFiles } from '../ai-vault/session-scanner-discovery'
import {
  writeEveryAgentVault,
  type EveryAgentVault
} from '../ai-vault/session-scanner-every-agent-fixture'
import { geminiJsonlFixture } from '../ai-vault/session-scanner-incremental-fixtures'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from '../ai-vault/session-scanner-parse-cache'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptMessage
} from '../ai-vault/session-transcript-consumers'
import { SELF_CONTAINED_TRANSCRIPT_AGENTS } from './session-search-index-consumer'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fs & { default: typeof fs }>()
  // Recursive spies alter native stream prototypes and prevent readers from finishing.
  const tracked = {
    readFile: vi.fn(original.readFile),
    readFileSync: vi.fn(original.readFileSync),
    open: vi.fn(original.open),
    openSync: vi.fn(original.openSync),
    createReadStream: vi.fn(original.createReadStream)
  }
  return { ...original, ...tracked, default: { ...original.default, ...tracked } }
})
vi.mock('node:fs/promises', { spy: true })
vi.mock('../native-chat/wsl-transcript-fs-access', { spy: true })

let root: string
let vault: EveryAgentVault

beforeAll(async () => {
  root = await fsPromises.mkdtemp(join(tmpdir(), 'ss-transcript-dependencies-'))
  vault = await writeEveryAgentVault(root)
  const gemini = geminiJsonlFixture()
  await fsPromises.writeFile(
    join(vault.roots.geminiSessionsDir, gemini.fileName),
    `${gemini.seedLines.join('\n')}\n`
  )
})

afterEach(() => {
  vi.clearAllMocks()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
})

afterAll(async () => {
  await fsPromises.rm(root, { recursive: true, force: true })
})

function contentReadPaths(): unknown[] {
  return [
    ...vi.mocked(fsPromises.readFile).mock.calls.map(([path]) => path),
    ...vi.mocked(fsPromises.open).mock.calls.map(([path]) => path),
    ...vi.mocked(fs.readFile).mock.calls.map(([path]) => path),
    ...vi.mocked(fs.readFileSync).mock.calls.map(([path]) => path),
    ...vi.mocked(fs.open).mock.calls.map(([path]) => path),
    ...vi.mocked(fs.openSync).mock.calls.map(([path]) => path),
    ...vi.mocked(fs.createReadStream).mock.calls.map(([path]) => path),
    ...vi.mocked(transcriptFs.wslGatedReadFile).mock.calls.map(([path]) => path),
    ...vi.mocked(transcriptFs.openTranscriptFile).mock.calls.map(([path]) => path),
    ...vi.mocked(transcriptFs.openTranscriptReadStream).mock.calls.map(([path]) => path),
    ...vi.mocked(transcriptFs.readTranscriptSlice).mock.calls.map(([path]) => path)
  ]
}

it.each(AI_VAULT_AGENTS.filter((agent) => SELF_CONTAINED_TRANSCRIPT_AGENTS[agent]))(
  '%s reads indexed content only from its candidate transcript',
  async (agent) => {
    const source = AI_VAULT_AGENT_SOURCES[agent]
    if (!source) {
      throw new Error(`${agent} needs a real transcript fixture before enabling file-stat reuse`)
    }
    expect(source.contentDependencyPath).toBeUndefined()
    const discoveries = await Promise.all(
      source.rootDirs(vault.roots, []).map((rootDir) =>
        discoverFiles({
          ...source,
          rootDir,
          agent,
          limit: 10,
          issues: [],
          extensions: [...source.extensions]
        })
      )
    )
    const files = discoveries.flatMap((discovery) => discovery.files)
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const candidate = { agent, file, codexHome: null }
      for (const read of ['direct', 'cached'] as const) {
        const messages: TranscriptMessage[] = []
        const sink = { active: true, push: (message: TranscriptMessage) => messages.push(message) }
        resetTranscriptConsumersForTests()
        resetSessionParseCacheForTests()
        registerTranscriptConsumer({
          beginRead: () => ({ message: sink.push, finish: () => undefined })
        })
        vi.clearAllMocks()

        const session = await (read === 'direct'
          ? parseAgentSessionFile(candidate, process.platform, sink)
          : parseAgentSessionFileCached(candidate, process.platform))

        expect(session).not.toBeNull()
        expect(messages.length).toBeGreaterThan(0)
        const paths = contentReadPaths()
        expect(paths).toContain(file.path)
        // Include failed optional reads: an absent sidecar can appear on a later scan.
        expect(
          paths.filter((path) => path !== file.path),
          `${read}: ${file.path}`
        ).toEqual([])
      }
    }
  }
)
