import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_DAEMON_LOGIN_SESSION_PROBE_BYTES,
  readDaemonLoginSessionProbeVerdict
} from './daemon-login-session-probe-verdict'

describe('daemon login-session probe verdict', () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true })))
  })

  async function createProbe(content: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'orca-daemon-login-probe-'))
    cleanupPaths.push(directory)
    const path = join(directory, 'verdict')
    await writeFile(path, content)
    return path
  }

  it('reads a normal verdict', async () => {
    expect(readDaemonLoginSessionProbeVerdict(await createProbe(' alive\n'))).toBe('alive')
  })

  it('fails inconclusive when the verdict file exceeds its cap', async () => {
    const path = await createProbe('x'.repeat(MAX_DAEMON_LOGIN_SESSION_PROBE_BYTES + 1))
    expect(readDaemonLoginSessionProbeVerdict(path)).toBe('')
  })
})
