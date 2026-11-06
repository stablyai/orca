import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  fishRequirementViolation,
  resolveFishBinary
} from '../../../shared/fish-binary-requirement'
import {
  buildFishVendorConfWrapperFile,
  FISH_XDG_DATA_DIRS_PREFIX_ENV,
  getFishXdgDataDirsLaunchEnv
} from './fish-xdg-data-dirs-handoff'

const ROOT = '/orca/shell-wrappers/abc'

describe('getFishXdgDataDirsLaunchEnv', () => {
  it.each([['-N'], ['--no-config'], ['--no-c'], ['-lN'], ['-Ni']])(
    'skips fish args that disable config: %s',
    (arg) => {
      expect(getFishXdgDataDirsLaunchEnv(ROOT, undefined, ['-l', arg])).toEqual({})
    }
  )

  it('skips a dir that XDG_DATA_DIRS cannot represent', () => {
    expect(getFishXdgDataDirsLaunchEnv('/odd:root', undefined)).toEqual({})
  })
})

const fishLookup = resolveFishBinary(3)
// The test shells run with a minimal PATH.
const fish = fishLookup.available
  ? {
      available: true,
      path: spawnSync('sh', ['-c', `command -v ${fishLookup.path}`], {
        encoding: 'utf8'
      }).stdout.trim()
    }
  : { available: false, path: '' }
const FAKE_CODEX = `#!/bin/sh
if [ "$1" = --help ]; then echo "  --no-daemon"; exit 0; fi
echo "fake-codex $*"
`
const STATE_PROBE = [
  'set -q XDG_DATA_DIRS; and echo "xdg=[$XDG_DATA_DIRS]"; or echo xdg=unset',
  `set -q ${FISH_XDG_DATA_DIRS_PREFIX_ENV}; and echo marker-left`,
  'env | grep "^XDG_DATA_DIRS=\\|ORCA_FISH"; or echo child-clean',
  'functions -q __orca_fish_xdg_handoff; and echo handoff-left'
].join('\n')

// CI sets ORCA_REQUIRE_FISH so a missing binary must fail rather than skip.
it('finds fish when the environment requires it', () => {
  expect(fishRequirementViolation(fishLookup)).toBeNull()
})

describe.skipIf(!fish.available)('fish vendor snippet in a real fish', () => {
  let sandbox: string
  let root: string
  let bin: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'orca-fish-xdg-'))
    root = join(sandbox, 'root')
    bin = join(sandbox, 'bin')
    const [snippetPath, snippet] = buildFishVendorConfWrapperFile(root)
    mkdirSync(dirname(snippetPath), { recursive: true })
    writeFileSync(snippetPath, snippet)
    mkdirSync(join(sandbox, 'home', '.config', 'fish'), { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), FAKE_CODEX)
    chmodSync(join(bin, 'codex'), 0o755)
  })

  afterEach(() => {
    // Fish may finish its universal-variable write after the shell exits.
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  })

  function runFish(args: string[], env: Record<string, string>): string {
    const result = spawnSync(String(fish.path), args, {
      encoding: 'utf8',
      env: {
        HOME: join(sandbox, 'home'),
        PATH: `${bin}:/usr/bin:/bin`,
        ...env
      }
    })
    expect(result.stderr).toBe('')
    return result.stdout
  }

  // Distro vendor snippets such as snapd may change XDG_DATA_DIRS themselves.
  it.each([['/opt/a:/opt/b/'], ['/opt/a:'], [undefined]] as const)(
    'leaves fish exactly as it starts without Orca when XDG_DATA_DIRS is %s',
    (inherited) => {
      const base: Record<string, string> =
        inherited === undefined ? {} : { XDG_DATA_DIRS: inherited }
      const withoutOrca = runFish(['-c', STATE_PROBE], base)
      const withOrca = runFish(['-c', STATE_PROBE], {
        ...base,
        ...getFishXdgDataDirsLaunchEnv(root, inherited)
      })
      expect(withOrca).toBe(withoutOrca)
      expect(withOrca).not.toContain('marker-left')
      expect(withOrca).not.toContain('handoff-left')
    }
  )

  it('wraps a typed codex at the first prompt', () => {
    const output = runFish(
      ['-i', '-c', 'emit fish_prompt; type -t codex; codex hi'],
      getFishXdgDataDirsLaunchEnv(root, undefined)
    )
    expect(output).toContain('function\nfake-codex --no-daemon hi')
  })

  it('keeps the opt-out', () => {
    const output = runFish(['-i', '-c', 'emit fish_prompt; codex hi'], {
      ...getFishXdgDataDirsLaunchEnv(root, undefined),
      ORCA_CODEX_ISOLATE: '0'
    })
    expect(output).toContain('fake-codex hi')
  })

  it("lets the user's own config.fish codex win", () => {
    writeFileSync(
      join(sandbox, 'home', '.config', 'fish', 'config.fish'),
      'function codex; echo user-codex $argv; end\n'
    )
    const output = runFish(
      ['-i', '-c', 'emit fish_prompt; codex hi'],
      getFishXdgDataDirsLaunchEnv(root, undefined)
    )
    expect(output).toContain('user-codex hi')
  })

  it('defines nothing in a non-interactive fish', () => {
    const output = runFish(
      ['-c', 'emit fish_prompt; type -t codex; functions -q __orca_define_codex; and echo hook'],
      getFishXdgDataDirsLaunchEnv(root, undefined)
    )
    // fish’s greeting handler also runs for this event.
    expect(output.trim()).toMatch(/file$/)
  })
})
