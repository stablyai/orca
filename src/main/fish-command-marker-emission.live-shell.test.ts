/**
 * Real-fish proof that a wrapped fish pane emits a well-formed command marker.
 *
 * Why a live shell: the bug this pins is invisible in the generated text.
 * `string replace -a '\n'` reads as "strip newlines", but fish single quotes do
 * not interpret escapes, so it only ever matched a literal backslash-n — and GNU
 * coreutils `base64` wraps at 76 columns while macOS `base64` does not. On every
 * Linux/WSL/SSH fish host that turned any command longer than 57 bytes into a
 * space-bearing payload the scanner then rejected, silently dropping the marker.
 * A macOS-only run cannot see it, so the wrapping case puts a line-wrapping
 * `base64` ahead of the real one on PATH.
 *
 * The init text goes straight to `fish -C`, the way getShellLaunchConfig returns
 * it. Sourcing it from a file instead puts it in a different scope and would test
 * something the launcher never does.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import {
  SHELL_COMMAND_NONCE_ENV,
  SHELL_INTEGRATION_CONTEXT_ENV,
  SHELL_INTEGRATION_DIRECT_CONTEXT
} from './shell-command-marker-template'

const FISH_PATH = (() => {
  try {
    return execFileSync('/bin/bash', ['-lc', 'command -v fish'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()
const itWithFish = FISH_PATH ? it : it.skip

const NONCE = 'live-fish-nonce'
const OSC = `${String.fromCharCode(27)}]`
const BEL = String.fromCharCode(7)
const MARKER_PREFIX = `${OSC}777;orca-cmd;`

describe('fish private command markers (real fish)', () => {
  let root: string
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-fish-marker-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = root
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(root, { recursive: true, force: true })
  })

  /** The real launch decision, so a pane Orca would not wrap cannot pass here. */
  function fishInit(): string {
    const features = selectShellStartupFeatures({
      shellPath: FISH_PATH,
      env: {},
      hasStartupCommand: true,
      waitsForShellReady: true,
      emitsStartupIdentity: true,
      injectsCommandMarkers: true
    })
    expect(features).toContain('markers')
    const config = getShellLaunchConfig(FISH_PATH, features, { commandNonce: NONCE })
    expect(config.args?.[1]).toBe('-C')
    return config.args?.[2] as string
  }

  // Why PATH is set inside -c and not in env: `fish -l` runs path_helper, which
  // rebuilds PATH and drops an inherited prefix before the handler ever runs.
  function runPreexec(command: string, pathPrefix?: string): string {
    const prefix = pathPrefix ? `set -gx PATH ${JSON.stringify(pathPrefix)} $PATH; ` : ''
    return execFileSync(
      FISH_PATH,
      ['-l', '-C', fishInit(), '-c', `${prefix}emit fish_preexec ${JSON.stringify(command)}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          [SHELL_COMMAND_NONCE_ENV]: NONCE,
          [SHELL_INTEGRATION_CONTEXT_ENV]: SHELL_INTEGRATION_DIRECT_CONTEXT
        }
      }
    )
  }

  function payloads(stdout: string): string[] {
    return stdout
      .split(MARKER_PREFIX)
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf(BEL)))
  }

  itWithFish('emits one nonce-carrying marker with the command it ran', () => {
    const found = payloads(runPreexec('echo hello-marker'))

    expect(found.length).toBe(1)
    const [nonce, encoded] = found[0]!.split(';')
    expect(nonce).toBe(NONCE)
    expect(Buffer.from(encoded!, 'base64').toString('utf8')).toBe('echo hello-marker')
  })

  itWithFish('emits the OSC 133 command-start after the private marker', () => {
    const stdout = runPreexec('echo ordering')

    const markerIndex = stdout.indexOf(`${MARKER_PREFIX}${NONCE};`)
    expect(markerIndex).toBeGreaterThanOrEqual(0)
    expect(stdout.indexOf(`${OSC}133;C${BEL}`)).toBeGreaterThan(markerIndex)
  })

  // Why a long command plus a wrapping base64: this is the Linux/WSL shape.
  itWithFish('keeps the payload unwrapped when base64 wraps at 76 columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-wrapb64-'))
    const shim = join(dir, 'base64')
    writeFileSync(shim, '#!/bin/sh\nexec /usr/bin/base64 "$@" | fold -w 76\n', 'utf8')
    chmodSync(shim, 0o755)
    try {
      const command = `claude --resume ${'a'.repeat(200)}`
      const found = payloads(runPreexec(command, dir))

      expect(found.length).toBe(1)
      const [, encoded] = found[0]!.split(';')
      expect(encoded).not.toMatch(/\s/)
      expect(Buffer.from(encoded!, 'base64').toString('utf8')).toBe(command)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  itWithFish('stays silent when the pane carries no nonce', () => {
    const env = {
      ...process.env,
      [SHELL_INTEGRATION_CONTEXT_ENV]: SHELL_INTEGRATION_DIRECT_CONTEXT
    }
    delete env[SHELL_COMMAND_NONCE_ENV]

    const stdout = execFileSync(
      FISH_PATH,
      ['-l', '-C', fishInit(), '-c', 'emit fish_preexec "echo quiet"'],
      { encoding: 'utf8', env }
    )

    expect(stdout).not.toContain('orca-cmd')
  })

  // Why postexec: fish_preexec alone leaves 133;C unpaired, so a fish pane never
  // reports command-finished -- no clear-on-finish and no exit code.
  function runPostexec(seed: string, command: string): string {
    return execFileSync(
      FISH_PATH,
      ['-l', '-C', fishInit(), '-c', `${seed}; emit fish_postexec ${JSON.stringify(command)}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          [SHELL_COMMAND_NONCE_ENV]: NONCE,
          [SHELL_INTEGRATION_CONTEXT_ENV]: SHELL_INTEGRATION_DIRECT_CONTEXT
        }
      }
    )
  }

  itWithFish('closes the OSC 133 lifecycle with the real command exit status', () => {
    expect(runPostexec('true', 'true')).toContain(`${OSC}133;D;0${BEL}`)
    expect(runPostexec('false', 'false')).toContain(`${OSC}133;D;1${BEL}`)
  })

  itWithFish('emits no command-finished when the pane carries no nonce', () => {
    const env = {
      ...process.env,
      [SHELL_INTEGRATION_CONTEXT_ENV]: SHELL_INTEGRATION_DIRECT_CONTEXT
    }
    delete env[SHELL_COMMAND_NONCE_ENV]

    const stdout = execFileSync(
      FISH_PATH,
      ['-l', '-C', fishInit(), '-c', 'false; emit fish_postexec "false"'],
      { encoding: 'utf8', env }
    )

    expect(stdout).not.toContain(`${OSC}133;D`)
  })

  // Why this pairing matters: `onCommandStarted` (OSC 133;C) is what cancels the
  // deferred identity drop a previous `D` scheduled. A `D` with no `C` therefore
  // retires a pane's live agent identity with nothing left to invalidate it, so
  // the two markers have to share one capability gate.
  itWithFish('emits neither lifecycle marker when base64 is unavailable', () => {
    const empty = mkdtempSync(join(tmpdir(), 'orca-no-b64-'))
    // Replaces PATH rather than prefixing it: the point is that `base64` resolves nowhere.
    const stripBase64 = `set -gx PATH ${JSON.stringify(empty)}; `
    const run = (script: string): string =>
      execFileSync(FISH_PATH, ['-l', '-C', fishInit(), '-c', `${stripBase64}${script}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          [SHELL_COMMAND_NONCE_ENV]: NONCE,
          [SHELL_INTEGRATION_CONTEXT_ENV]: SHELL_INTEGRATION_DIRECT_CONTEXT
        }
      })
    try {
      // Pre-existing behaviour: no command text and no command-start.
      const started = run('emit fish_preexec "echo no-b64"')
      expect(started).not.toContain('orca-cmd')
      expect(started).not.toContain(`${OSC}133;C`)
      // The half that was unguarded: postexec must stay silent too.
      const finished = run('false; emit fish_postexec "false"')
      expect(finished).not.toContain(`${OSC}133;D`)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
