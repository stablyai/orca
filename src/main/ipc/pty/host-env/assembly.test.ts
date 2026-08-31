import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../../../config/scripts/vitest-host-ports-setup'
import { buildPtyHostEnv } from './assembly'

describe('buildPtyHostEnv OMP readiness extension', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-omp-readiness-host-env-'))
    installFakeAppEnvironment({
      getPath: (name) => {
        if (name === 'userData') {
          return userDataPath
        }
        throw new Error(`unexpected app.getPath(${name})`)
      }
    })
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function build(launchCommand?: string): Record<string, string> {
    return buildPtyHostEnv(
      'pty-omp-readiness',
      {
        ORCA_OMP_STATUS_EXTENSION: 'stale-full-status-extension',
        ORCA_OMP_SOURCE_AGENT_DIR: 'stale-source-home'
      },
      {
        isPackaged: false,
        userDataPath,
        selectedCodexHomePath: null,
        agentStatusHooksEnabled: false,
        launchCommand
      }
    )
  }

  it.each(['omp', undefined])(
    'reinstalls only the readiness extension for hooks-disabled %s launches',
    (launchCommand) => {
      const env = build(launchCommand)
      const readinessPath = join(
        userDataPath,
        'omp-prompt-readiness-extension',
        'orca-omp-prompt-readiness.ts'
      )

      expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(readinessPath)
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBeUndefined()
      const source = readFileSync(readinessPath, 'utf8')
      expect(source).toContain('installOmpPromptReadiness')
      expect(source).not.toContain("return '/hook/omp'")
    }
  )

  it('does not inject OMP readiness into a hooks-disabled non-OMP command', () => {
    const env = build('codex')

    expect(env.ORCA_OMP_STATUS_EXTENSION).toBeUndefined()
    expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBeUndefined()
  })
})
