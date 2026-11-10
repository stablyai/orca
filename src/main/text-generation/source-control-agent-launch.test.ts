import 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunProcess from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import '../provider-process/provider-process-supervisor'
import { generateCommitMessageFromContext } from './commit-message-text-generation'
import './commit-message-text-generation-test-harness'
import './source-control-agent-launch'

const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }))

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof RunProcess>()
  spawnProcessMock.mockImplementation(actual.spawnProcess)
  return { ...actual, spawnProcess: spawnProcessMock }
})

function lastSpawnSpec(): ProcessSpec {
  return spawnProcessMock.mock.calls.at(-1)![0]
}

function decodedSupervisorSpec(spec: ProcessSpec): Record<string, unknown> {
  return JSON.parse(Buffer.from(spec.env!.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
}

const folder = mkdtempSync(join(tmpdir(), 'orca-agent-launch-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

beforeEach(() => {
  spawnProcessMock.mockClear()
})

describe.runIf(process.platform !== 'win32')('supervised agent processes', () => {
  it('passes the stdin end through so the agent can answer its request', async () => {
    const agent = join(folder, 'echo-agent.cjs')
    writeFileSync(
      agent,
      `let prompt = ''
process.stdin.on('data', (chunk) => (prompt += chunk))
process.stdin.on('end', () => setTimeout(() => console.log(prompt.includes('README') ? 'Update README' : 'no prompt'), 1200))
`
    )

    await expect(
      generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M README.md',
          stagedPatch: '+test'
        },
        {
          agentId: 'custom',
          model: '',
          customAgentCommand: `"${process.execPath}" "${agent}"`
        },
        { kind: 'local', cwd: folder }
      )
    ).resolves.toMatchObject({ success: true, message: 'Update README' })
    expect(lastSpawnSpec().program).toBe(process.execPath)
    expect(decodedSupervisorSpec(lastSpawnSpec())).toMatchObject({
      lifetime: 'one-shot'
    })
  })
})
