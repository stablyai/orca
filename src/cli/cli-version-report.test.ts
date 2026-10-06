import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '../shared/protocol-version'
import type { CliStatusResult } from '../shared/runtime-types'
import { isVersionRequest } from './cli-version-arguments'
import { buildCliVersionReport } from './cli-version-report'
import { main } from './index'

vi.mock('./cli-version', () => ({ readOrcaCliVersion: () => '1.5.0' }))

afterEach(() => {
  vi.unstubAllEnvs()
})

function reachableStatus(runtime: Partial<CliStatusResult['runtime']>): CliStatusResult {
  return {
    app: { running: true, pid: 1 },
    runtime: { state: 'ready', reachable: true, runtimeId: 'runtime-1', ...runtime },
    graph: { state: 'ready' }
  }
}

describe('isVersionRequest', () => {
  it.each([
    [['--version'], { json: false }],
    [['-v'], { json: false }],
    [['--version', '--json'], { json: true }],
    [['--json', '-v'], { json: true }]
  ])('accepts %j', (argv, expected) => {
    expect(isVersionRequest(argv)).toEqual(expected)
  })

  it.each([[[]], [['--json']], [['--version', '-v']], [['--version', 'status']]])(
    'leaves %j to the command parser',
    (argv) => {
      expect(isVersionRequest(argv)).toBeNull()
    }
  )
})

describe('buildCliVersionReport', () => {
  it('pairs the stamped client build with the reachable server protocol window', async () => {
    vi.stubEnv('ORCA_CLI_STANDALONE', '1')

    const report = await buildCliVersionReport(async () =>
      reachableStatus({
        appVersion: '1.4.0',
        runtimeProtocolVersion: 3,
        minCompatibleRuntimeClientVersion: 2
      })
    )

    expect(report).toEqual({
      client: {
        version: '1.5.0',
        standalone: true,
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeServerVersion: expect.any(Number)
      },
      server: {
        reachable: true,
        runtimeId: 'runtime-1',
        appVersion: '1.4.0',
        runtimeProtocolVersion: 3,
        minCompatibleRuntimeClientVersion: 2
      }
    })
  })

  it('keeps the client half when no runtime is running', async () => {
    const report = await buildCliVersionReport(async () => ({
      app: { running: false, pid: null },
      runtime: { state: 'not_running', reachable: false, runtimeId: null },
      graph: { state: 'not_running' }
    }))

    expect(report.client.version).toBe('1.5.0')
    expect(report.server).toEqual({ reachable: false })
  })

  it('reports why a selected server could not answer', async () => {
    const report = await buildCliVersionReport(async () => {
      throw new Error('This Orca client is too old for the selected server.')
    })

    expect(report.server).toEqual({
      reachable: false,
      error: 'This Orca client is too old for the selected server.'
    })
  })
})

describe('standalone --version --json', () => {
  it('prints the report without a runtime', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-version-report-'))
    try {
      vi.stubEnv('ORCA_USER_DATA_PATH', userDataPath)
      vi.stubEnv('ORCA_PAIRING_CODE', undefined)
      vi.stubEnv('ORCA_REMOTE_PAIRING', undefined)
      vi.stubEnv('ORCA_ENVIRONMENT', undefined)
      vi.stubEnv('ORCA_CLI_STANDALONE', '1')
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        await main(['--version', '--json'])
        const printed = JSON.parse(String(write.mock.calls[0]?.[0]))
        expect(printed).toMatchObject({
          client: { version: '1.5.0', standalone: true },
          server: { reachable: false }
        })
      } finally {
        write.mockRestore()
      }
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
  it('keeps the client half when ORCA_ENVIRONMENT names no saved environment', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-version-report-'))
    try {
      vi.stubEnv('ORCA_USER_DATA_PATH', userDataPath)
      vi.stubEnv('ORCA_PAIRING_CODE', undefined)
      vi.stubEnv('ORCA_REMOTE_PAIRING', undefined)
      vi.stubEnv('ORCA_ENVIRONMENT', 'missing-environment')
      vi.stubEnv('ORCA_CLI_STANDALONE', '1')
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        await main(['--version', '--json'])
        const printed = JSON.parse(String(write.mock.calls[0]?.[0]))
        expect(printed.client).toMatchObject({ version: '1.5.0', standalone: true })
        expect(printed.server).toMatchObject({ reachable: false, error: expect.any(String) })
      } finally {
        write.mockRestore()
      }
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
