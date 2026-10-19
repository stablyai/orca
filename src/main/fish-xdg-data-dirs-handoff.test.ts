import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getFishCodexShellLaunchPreflight } from '../shared/codex-shell-function'
import { fishRequirementViolation, resolveFishBinary } from '../shared/fish-binary-requirement'
import {
  buildFishVendorConfWrapperFile,
  FISH_XDG_DATA_DIRS_PREFIX_ENV,
  getFishVendorConfSnippet,
  getFishXdgDataDirsLaunchEnv
} from './fish-xdg-data-dirs-handoff'

const ROOT = '/orca/shell-wrappers/abc'
const DATA_DIR = `${ROOT}/fish-xdg-data`

describe('getFishXdgDataDirsLaunchEnv', () => {
  it('adds the XDG default after Orca when the variable is unset', () => {
    const expected = `${DATA_DIR}:/usr/local/share:/usr/share`
    expect(getFishXdgDataDirsLaunchEnv(ROOT, undefined)).toEqual({
      XDG_DATA_DIRS: expected,
      [FISH_XDG_DATA_DIRS_PREFIX_ENV]: expected
    })
  })

  it('treats an empty XDG_DATA_DIRS as unset', () => {
    expect(getFishXdgDataDirsLaunchEnv(ROOT, '')).toEqual(
      getFishXdgDataDirsLaunchEnv(ROOT, undefined)
    )
  })

  it.each([['-N'], ['--no-config'], ['--no-c'], ['-lN'], ['-Ni']])(
    'skips fish args that disable config: %s',
    (arg) => {
      expect(getFishXdgDataDirsLaunchEnv(ROOT, undefined, ['-l', arg])).toEqual({})
    }
  )

  it.for([['-l'], ['-i'], ['--login'], ['--no-execute'], ['--no-'], ['-c', 'echo N']])(
    'still hands off for fish args %j',
    (args) => {
      expect(getFishXdgDataDirsLaunchEnv(ROOT, undefined, args)).not.toEqual({})
    }
  )

  it('prepends to an existing value and records only its own entry', () => {
    expect(getFishXdgDataDirsLaunchEnv(ROOT, '/opt/a:/opt/b')).toEqual({
      XDG_DATA_DIRS: `${DATA_DIR}:/opt/a:/opt/b`,
      [FISH_XDG_DATA_DIRS_PREFIX_ENV]: DATA_DIR
    })
  })

  // Why: restore must hand back exactly what was inherited, stale Orca entry included.
  it('prepends again when the inherited value already names the dir', () => {
    const inherited = `${DATA_DIR}:/opt/a`
    expect(getFishXdgDataDirsLaunchEnv(ROOT, inherited).XDG_DATA_DIRS).toBe(
      `${DATA_DIR}:${inherited}`
    )
  })

  it('skips a dir that XDG_DATA_DIRS cannot represent', () => {
    expect(getFishXdgDataDirsLaunchEnv('/odd:root', undefined)).toEqual({})
  })
})

describe('fish vendor snippet', () => {
  it('embeds the shared fish codex function verbatim', () => {
    expect(getFishVendorConfSnippet()).toContain(getFishCodexShellLaunchPreflight())
  })

  it('lives where fish looks for vendor snippets under the data dir', () => {
    expect(buildFishVendorConfWrapperFile(ROOT)[0]).toBe(
      `${DATA_DIR}/fish/vendor_conf.d/orca-shell-integration.fish`
    )
  })
})

const fishLookup = resolveFishBinary(3)
// Why absolute: the shells below run with a minimal PATH.
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
// XDG_DATA_DIRS as fish and a child process see it.
const STATE_PROBE = [
  'set -q XDG_DATA_DIRS; and echo "xdg=[$XDG_DATA_DIRS]"; or echo xdg=unset',
  `set -q ${FISH_XDG_DATA_DIRS_PREFIX_ENV}; and echo marker-left`,
  'env | grep "^XDG_DATA_DIRS=\\|ORCA_FISH"; or echo child-clean',
  'functions -q __orca_fish_xdg_handoff; and echo handoff-left'
].join('\n')

// Why always run: the shell contracts job sets ORCA_REQUIRE_FISH so a missing fish fails, not skips.
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

  // Why a baseline: a distro vendor snippet (Ubuntu's snapd) may set XDG_DATA_DIRS itself.
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
    // Why a suffix: the emitted event also runs fish's own greeting handler.
    expect(output.trim()).toMatch(/file$/)
  })
})
