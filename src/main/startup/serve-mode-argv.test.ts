import { describe, expect, it } from 'vitest'
import {
  argvRequestsServeMode,
  findServeSubcommandIndex,
  normalizeServeModeArgv
} from './serve-mode-argv'

describe('serve-mode-argv', () => {
  it('detects --serve and bare serve subcommand', () => {
    expect(argvRequestsServeMode(['orca', '--serve'])).toBe(true)
    expect(argvRequestsServeMode(['/AppRun', 'serve'])).toBe(true)
    expect(argvRequestsServeMode(['/AppRun', '--no-sandbox', 'serve', '--port', '8080'])).toBe(true)
    expect(argvRequestsServeMode(['orca'])).toBe(false)
  })

  it('does not treat serve as a subcommand when it is an option value', () => {
    expect(findServeSubcommandIndex(['app', '--user-data-dir', 'serve'])).toBe(-1)
    expect(argvRequestsServeMode(['app', '--user-data-dir', 'serve'])).toBe(false)
    expect(normalizeServeModeArgv(['app', '--user-data-dir', 'serve'])).toEqual([
      'app',
      '--user-data-dir',
      'serve'
    ])
    expect(findServeSubcommandIndex(['app', '--user-data-dir', '/tmp/x', 'serve'])).toBe(3)
  })

  it('skips a space-separated Chromium switch value while locating serve', () => {
    const argv = ['/AppRun', '--disable-features', 'Vulkan', 'serve', '--port', '6768']
    expect(findServeSubcommandIndex(argv)).toBe(3)
    expect(normalizeServeModeArgv(argv)).toEqual([
      '/AppRun',
      '--disable-features',
      'Vulkan',
      '--serve',
      '--serve-port',
      '6768'
    ])
  })

  it('refuses a help launch instead of binding a server', () => {
    // Help once launched a network-exposed pairing server silently; route CLI-form help to the CLI.
    for (const argv of [
      ['/AppRun', 'serve', '--help'],
      ['/AppRun', 'serve', '-h'],
      ['/AppRun', '--help', 'serve'],
      ['/AppRun', 'help', 'serve'],
      ['/AppRun', 'serve', 'help']
    ]) {
      expect(argvRequestsServeMode(argv), argv.join(' ')).toBe(false)
      expect(normalizeServeModeArgv(argv)).toEqual(argv)
    }
    // A value named help is not a help request.
    expect(argvRequestsServeMode(['/AppRun', 'serve', '--project-root', 'help'])).toBe(true)
    // Never reinterpret tokens after the operator's -- terminator.
    expect(argvRequestsServeMode(['/AppRun', 'serve', '--', '--help'])).toBe(true)
  })

  it('does not turn `--no-pairing=false` into no-pairing', () => {
    // CLI booleans require bare flags; translating --no-pairing=false would drop its value and invert operator intent.
    expect(
      normalizeServeModeArgv(['/AppRun', 'serve', '--port', '6768', '--no-pairing=false'])
    ).toEqual(['/AppRun', '--serve', '--serve-port', '6768', '--no-pairing=false'])
    expect(normalizeServeModeArgv(['/AppRun', 'serve', '--mobile-pairing=0'])).toEqual([
      '/AppRun',
      '--serve',
      '--mobile-pairing=0'
    ])
  })

  it('leaves real GUI launch argv alone', () => {
    // False serve detection replaces a desktop window with a listening runtime; exercise actual desktop argv shapes.
    for (const argv of [
      ['/Applications/Orca.app/Contents/MacOS/Orca', '-psn_0_123456'],
      ['C:\\Program Files\\Orca\\Orca.exe', '--squirrel-firstrun'],
      ['C:\\Program Files\\Orca\\Orca.exe', 'orca://worktree/serve'],
      ['/opt/orca/orca-ide', '/home/u/serve'],
      // Value tokens named serve are never subcommands.
      ['/opt/orca/orca-ide', '--pairing-code', 'serve'],
      ['/opt/orca/orca-ide', '--environment=serve'],
      ['/opt/orca/orca-ide', '--', 'serve'],
      ['/opt/orca/orca-ide', 'Serve']
    ]) {
      expect(argvRequestsServeMode(argv), argv.join(' ')).toBe(false)
      expect(normalizeServeModeArgv(argv)).toEqual(argv)
    }
  })

  it('does not treat a later positional serve as the subcommand after another command', () => {
    expect(findServeSubcommandIndex(['app', 'status', 'serve'])).toBe(-1)
    expect(argvRequestsServeMode(['app', 'status', 'serve'])).toBe(false)
  })

  it('rewrites CLI-form serve flags into --serve* form', () => {
    expect(
      normalizeServeModeArgv([
        '/AppRun',
        'serve',
        '--port',
        '9090',
        '--json',
        '--pairing-address',
        '0.0.0.0',
        '--no-pairing'
      ])
    ).toEqual([
      '/AppRun',
      '--serve',
      '--serve-port',
      '9090',
      '--serve-json',
      '--serve-pairing-address',
      '0.0.0.0',
      '--serve-no-pairing'
    ])
  })

  it('keeps Electron-injected Chromium switches while normalizing direct serve', () => {
    expect(
      normalizeServeModeArgv([
        '/opt/orca/orca-ide',
        '--disable-features=FedCm,DirectSockets',
        'serve',
        '--port',
        '6768'
      ])
    ).toEqual([
      '/opt/orca/orca-ide',
      '--disable-features=FedCm,DirectSockets',
      '--serve',
      '--serve-port',
      '6768'
    ])
  })

  it('leaves already-normalized argv unchanged', () => {
    // Exercise every value flag in mixed --serve argv emitted by the CLI; rewriting must preserve its port.
    const argv = [
      'orca',
      '--serve',
      '--serve-json',
      '--serve-port',
      '6768',
      '--serve-pairing-address',
      '100.64.1.20',
      '--serve-no-pairing',
      '--serve-mobile-pairing',
      '--serve-recipe-json',
      '--serve-project-root',
      '/srv/repo'
    ]
    expect(normalizeServeModeArgv(argv)).toEqual(argv)
  })

  it('splits `--flag=value` CLI form, which getServeOptions cannot read', () => {
    expect(
      normalizeServeModeArgv(['/AppRun', 'serve', '--port=9090', '--pairing-address=0.0.0.0'])
    ).toEqual(['/AppRun', '--serve', '--serve-port', '9090', '--serve-pairing-address', '0.0.0.0'])
  })

  it('keeps equals-form values that start with a flag marker intact', () => {
    expect(normalizeServeModeArgv(['/AppRun', 'serve', '--pairing-address=--no-pairng'])).toEqual([
      '/AppRun',
      '--serve',
      '--serve-pairing-address=--no-pairng'
    ])
  })

  it('translates serve flags in the mixed `--serve --port` form', () => {
    expect(normalizeServeModeArgv(['orca', '--serve', '--port', '9090', '--no-pairing'])).toEqual([
      'orca',
      '--serve',
      '--serve-port',
      '9090',
      '--serve-no-pairing'
    ])
  })

  it('leaves a non-serve launch untouched', () => {
    const argv = ['orca', '--no-sandbox', '/home/u/project']
    expect(argvRequestsServeMode(argv)).toBe(false)
    expect(normalizeServeModeArgv(argv)).toEqual(argv)
  })

  it('does not splice prototype members onto argv for stray positionals', () => {
    expect(normalizeServeModeArgv(['/AppRun', 'serve', 'toString'])).toEqual([
      '/AppRun',
      '--serve',
      'toString'
    ])
  })

  it('passes args after `--` through verbatim', () => {
    expect(normalizeServeModeArgv(['/AppRun', 'serve', '--json', '--', '--port', '1'])).toEqual([
      '/AppRun',
      '--serve',
      '--serve-json',
      '--',
      '--port',
      '1'
    ])
  })

  it('never disagrees with itself about whether a launch is serve mode', () => {
    // Detection must skip a superset of rewrite-consumed values or malformed argv can swallow serve and drop all its flags (#12677).
    const alphabet = [
      'serve',
      '--serve',
      '--port',
      '--json',
      '--pairing-code',
      '--user-data-dir',
      '--',
      '-h',
      'help',
      'value',
      '--port=1',
      '--no-pairing=false'
    ]
    const disagreements: string[][] = []
    const walk = (tail: string[]): void => {
      const argv = ['/AppRun', ...tail]
      if (argvRequestsServeMode(argv) !== normalizeServeModeArgv(argv).includes('--serve')) {
        disagreements.push(argv)
      }
      if (tail.length === 4) {
        return
      }
      for (const token of alphabet) {
        walk([...tail, token])
      }
    }
    walk([])

    expect(disagreements).toEqual([])
  })
})
