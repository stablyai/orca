import type * as NodeFs from 'node:fs'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  MAC_UPDATE_INSTALL_LAUNCH_EXIT_CODE,
  markMacUpdateInstallInFlight,
  clearMacUpdateInstallMarker,
  exitForInFlightMacUpdateInstall,
  shouldExitForInFlightMacUpdateInstall
} from './mac-update-install-marker'

const mock = vi.hoisted(() => ({
  root: '',
  version: '1.2.3',
  packaged: true,
  run: vi.fn(),
  exit: vi.fn(),
  read: vi.fn<(path: NodeFs.PathLike | undefined, bytes: number) => void>(),
  opened: vi.fn(),
  closed: vi.fn(),
  beforeRename: vi.fn()
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mock.packaged
    },
    exit: mock.exit,
    getVersion: () => mock.version,
    getPath: () => mock.root
  }
}))
vi.mock('@orca/process-host', () => ({ runProcessSync: mock.run }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFs>()
  const paths = new Map<number, NodeFs.PathLike>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      paths.set(fd, args[0])
      mock.opened(fd)
      return fd
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      mock.read(paths.get(fd), buffer.byteLength)
      return fs.readSync(fd, buffer, offset, length, position)
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd)
      paths.delete(fd)
      mock.closed(fd)
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      mock.beforeRename()
      fs.renameSync(...args)
    }
  }
})
let bundle: string
let executable: string
let directory: string
let statePath: string
let command: string
let diagnostic: ReturnType<typeof vi.spyOn>
const now = 1_800_000_000_000
const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

beforeEach(() => {
  Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true })
  mock.exit.mockClear()
  mock.root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-install-fence-')))
  bundle = join(mock.root, 'Orca QA.app')
  executable = join(bundle, 'Contents', 'MacOS', 'Orca')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(executable, '')
  mock.beforeRename.mockReset()
  mock.version = '1.2.3'
  mock.packaged = true
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.spyOn(process, 'execPath', 'get').mockReturnValue(executable)
  vi.spyOn(Date, 'now').mockReturnValue(now)
  diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubEnv('ORCA_BYPASS_UPDATE_INSTALL_LAUNCH_GATE', '')
  directory = join(
    mock.root,
    'orca-update-install-handoffs',
    createHash('sha256').update(executable).digest('hex')
  )
  statePath = join(mock.root, 'Native cache', 'ShipItState.plist')
  mkdirSync(join(mock.root, 'Native cache'))
  writeRequest()
  command = `${bundle}/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.stablyai.orca.ShipIt ${statePath}\n`
  mock.run.mockReset().mockImplementation(() => ({
    code: 0,
    stdout: command,
    timedOut: false,
    outputTruncated: false
  }))
  markMacUpdateInstallInFlight('1.3.0')
})
afterEach(() => {
  clearMacUpdateInstallMarker()
  rmSync(mock.root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (resourcesPathDescriptor) {
    Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor)
  } else {
    Reflect.deleteProperty(process, 'resourcesPath')
  }
})
function setCommand(value: string): void {
  command = value
}
function setVersion(value: string): void {
  mock.version = value
}
type NativeRequestOverrides = {
  launchAfterInstallation?: boolean | null
  bundleIdentifier?: string
  targetBundleURL?: string | null
  updateBundleURL?: string | null
}
type InstallAttemptOverrides = {
  targetVersion?: string
  schema?: number
  execPath?: string
  bundlePath?: string
}
function writeRequest(overrides: NativeRequestOverrides = {}) {
  writeFileSync(
    statePath,
    JSON.stringify({
      launchAfterInstallation: true,
      useUpdateBundleName: false,
      updateBundleURL: pathToFileURL(join(mock.root, 'Downloaded update.app')).href,
      bundleIdentifier: 'com.stablyai.orca',
      targetBundleURL: pathToFileURL(`${bundle}/`).href,
      ...overrides
    })
  )
}
function markerPath() {
  return join(
    directory,
    readdirSync(directory).find((name) => name.endsWith('.json'))!
  )
}
function changeMarker(overrides: InstallAttemptOverrides) {
  const path = markerPath()
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...overrides }))
}

it('publishes private per-attempt files and withdraws exactly its own attempt across racing writers', async () => {
  const first = markerPath()
  expect(statSync(first).mode & 0o777).toBe(0o600)
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  expect(JSON.parse(readFileSync(first, 'utf8'))).toMatchObject({
    schema: 1,
    execPath: executable,
    bundlePath: bundle,
    sourceVersion: '1.2.3',
    targetVersion: '1.3.0',
    createdAtMs: now
  })
  vi.resetModules()
  const otherWriter = await import('./mac-update-install-marker')
  otherWriter.markMacUpdateInstallInFlight('1.4.0')
  expect(readdirSync(directory)).toHaveLength(2)
  otherWriter.clearMacUpdateInstallMarker()
  expect(readdirSync(directory)).toEqual([first.slice(directory.length + 1)])
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(true)
  expect(MAC_UPDATE_INSTALL_LAUNCH_EXIT_CODE).toBe(75)
  expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('source=1.2.3 target=1.3.0'))
  expect(diagnostic).toHaveBeenCalledWith(
    expect.stringContaining('ORCA_BYPASS_UPDATE_INSTALL_LAUNCH_GATE=1')
  )
})

it.each([
  [
    'versioned framework path',
    () => setCommand(command.replace('/Resources/ShipIt ', '/Versions/A/Resources/ShipIt ')),
    true
  ],
  ['lower install target', () => changeMarker({ targetVersion: '1.0.0' }), true],
  ['installed higher version', () => setVersion('1.3.0'), false],
  ['installed lower version', () => setVersion('1.0.0'), false],
  ['same-version install', () => changeMarker({ targetVersion: '1.2.3' }), false],
  ['invalid version', () => changeMarker({ targetVersion: 'unknown' }), false],
  ['unknown schema', () => changeMarker({ schema: 2 }), false],
  ['other executable', () => changeMarker({ execPath: '/other/Orca' }), false],
  ['other bundle identity', () => changeMarker({ bundlePath: '/other/Orca.app' }), false],
  ['future clock', () => vi.mocked(Date.now).mockReturnValue(now - 1), false],
  ['expired', () => vi.mocked(Date.now).mockReturnValue(now + 600_001), false],
  ['corrupt', () => writeFileSync(markerPath(), '{'), false],
  ['oversized', () => writeFileSync(markerPath(), ' '.repeat(4097)), false],
  ['missing marker', () => clearMacUpdateInstallMarker(), false],
  ['dead installer', () => setCommand(''), false],
  ['other copy installer', () => setCommand(command.replace(bundle, '/other/Orca.app')), false],
  ['substring mention', () => setCommand(`/bin/echo ${command}`), false],
  ['argv zero boundary', () => setCommand(command.replace('/ShipIt ', '/ShipIt-extra ')), false],
  [
    'launch-only helper',
    () => setCommand(command.replace('com.stablyai.orca.ShipIt', '___launch___')),
    false
  ],
  [
    'pre-native crash with already-staged installer',
    () => writeRequest({ launchAfterInstallation: false }),
    false
  ],
  ['missing relaunch flag', () => writeRequest({ launchAfterInstallation: null }), false],
  [
    'other request target',
    () => writeRequest({ targetBundleURL: 'file:///other/Orca.app' }),
    false
  ],
  ...(['targetBundleURL', 'updateBundleURL'] as const).flatMap((field) =>
    [undefined, null, '', 'not a URL', 'https://example.com/Orca.app', 'file:///bad%XX'].map(
      (value) =>
        [
          `invalid required ${field}: ${value}`,
          () => writeRequest({ [field]: value }),
          false
        ] as const
    )
  ),
  ['mismatched native job label', () => writeRequest({ bundleIdentifier: 'other' }), false],
  ['unreadable request', () => rmSync(statePath), false],
  ['probe nonzero', () => mock.run.mockReturnValue({ code: 1, stdout: command }), false],
  [
    'probe timeout',
    () => mock.run.mockReturnValue({ code: 0, stdout: command, timedOut: true }),
    false
  ],
  [
    'probe truncation',
    () => mock.run.mockReturnValue({ code: 0, stdout: command, outputTruncated: true }),
    false
  ],
  [
    'disappeared on recheck',
    () =>
      mock.run
        .mockReturnValueOnce({ code: 0, stdout: command })
        .mockReturnValueOnce({ code: 0, stdout: '' }),
    false
  ],
  ['development', () => Object.assign(mock, { packaged: false }), false],
  ['non-macOS', () => vi.spyOn(process, 'platform', 'get').mockReturnValue('linux'), false],
  ['bypass', () => vi.stubEnv('ORCA_BYPASS_UPDATE_INSTALL_LAUNCH_GATE', '1'), false]
] as const)('%s', (_name, prepare, refuses) => {
  prepare()
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(refuses)
})

it('does no process probe without relevant evidence; unknown retains records and dead retires exactly', () => {
  mock.run.mockImplementation(() => {
    throw new Error('unavailable')
  })
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  const path = markerPath()
  expect(existsSync(path)).toBe(true)
  mock.run.mockReturnValue({
    code: 0,
    stdout: command.replace('com.stablyai.orca.ShipIt', 'unknown')
  })
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  expect(existsSync(path)).toBe(true)
  mock.run.mockReturnValue({ code: 0, stdout: '' })
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  expect(existsSync(path)).toBe(false)
  mock.run.mockClear()
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  expect(mock.run).not.toHaveBeenCalled()
})

it('ignores incomplete publications and prunes only expired owned names without hiding older live attempts', () => {
  const first = markerPath()
  const old = `attempt-${now - 600_001}-123-00000000-0000-4000-8000-000000000000.json.tmp`
  writeFileSync(join(directory, old), '{')
  writeFileSync(join(directory, 'foreign.json'), 'keep')
  writeFileSync(`${first}.tmp`, '{')
  markMacUpdateInstallInFlight('1.4.0')
  clearMacUpdateInstallMarker()
  expect(existsSync(join(directory, old))).toBe(false)
  expect(existsSync(join(directory, 'foreign.json'))).toBe(true)
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(true)
  expect(existsSync(first)).toBe(true)
})

it('treats unbounded directories and failed publication as uncertainty', () => {
  for (let index = 0; index < 257; index++) {
    writeFileSync(join(directory, `foreign-${index}`), '')
  }
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
  expect(() => markMacUpdateInstallInFlight('1.4.0')).not.toThrow()
  expect(mock.run).not.toHaveBeenCalled()
  const alias = join(mock.root, 'Alias.app')
  symlinkSync(bundle, alias)
  vi.spyOn(process, 'execPath', 'get').mockReturnValue(join(alias, 'Contents', 'MacOS', 'Orca'))
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
})

it('does not observe a temporary publication before its atomic rename', () => {
  clearMacUpdateInstallMarker()
  mock.beforeRename.mockImplementation(() => {
    expect(shouldExitForInFlightMacUpdateInstall()).toBe(false)
    expect(mock.run).not.toHaveBeenCalled()
  })
  markMacUpdateInstallInFlight('1.3.0')
  expect(shouldExitForInFlightMacUpdateInstall()).toBe(true)
})

it.each([10, 100])(
  'shares native evidence across %i real attempts through the desktop exit adapter',
  (count) => {
    for (let index = 1; index < count; index++) {
      markMacUpdateInstallInFlight('1.0.0')
    }
    expect(readdirSync(directory)).toHaveLength(count)
    setCommand(
      command + Array.from({ length: count }, (_, index) => `/bin/other-${index}`).join('\n')
    )
    vi.spyOn(process, 'argv', 'get').mockReturnValue([executable])
    mock.read.mockClear()
    mock.opened.mockClear()
    mock.closed.mockClear()

    expect(exitForInFlightMacUpdateInstall()).toBe(true)
    expect(mock.exit).toHaveBeenCalledExactlyOnceWith(75)
    expect(mock.run).toHaveBeenCalledTimes(2)
    expect(mock.run).toHaveBeenNthCalledWith(1, {
      program: '/bin/ps',
      args: ['-axww', '-o', 'command='],
      timeoutMs: 1000,
      maxOutputBytes: 8 * 1024 * 1024
    })
    expect(mock.run).toHaveBeenNthCalledWith(2, mock.run.mock.calls[0]![0])
    expect(mock.read.mock.calls.filter(([path]) => path === statePath)).toEqual([
      [statePath, 65537],
      [statePath, 65537]
    ])
    const records = mock.read.mock.calls.filter(([path]) => path !== statePath)
    expect(records).toHaveLength(count)
    expect(new Set(records.map(([path]) => path)).size).toBe(count)
    for (const [path, bytes] of records) {
      expect(path).toEqual(expect.stringContaining(`${directory}/attempt-`))
      expect(bytes).toBe(4097)
    }
    expect(mock.opened).toHaveBeenCalledTimes(count + 2)
    expect(mock.closed.mock.calls).toEqual(mock.opened.mock.calls)

    mock.exit.mockClear()
    mock.run.mockClear()
    setCommand('')
    expect(exitForInFlightMacUpdateInstall()).toBe(false)
    expect(mock.run).toHaveBeenCalledTimes(1)
    expect(readdirSync(directory)).toHaveLength(0)
    mock.run.mockClear()
    expect(exitForInFlightMacUpdateInstall()).toBe(false)
    expect(mock.run).not.toHaveBeenCalled()
    expect(mock.exit).not.toHaveBeenCalled()
  }
)

it.each([
  ['--serve', '--profile-state-recovery', '{"raw":"payload"}'],
  ['serve', '--profile-state-recovery', '{"raw":"payload"}'],
  ['/resources/app.asar.unpacked/out/cli/index.js', 'status']
])('bypasses the real desktop adapter without consuming raw launch arguments: %j', (...args) => {
  const argv = [executable, ...args]
  const original = [...argv]
  vi.spyOn(process, 'argv', 'get').mockReturnValue(argv)
  mock.opened.mockClear()
  mock.read.mockClear()
  expect(exitForInFlightMacUpdateInstall()).toBe(false)
  expect(argv).toEqual(original)
  expect(mock.opened).not.toHaveBeenCalled()
  expect(mock.read).not.toHaveBeenCalled()
  expect(mock.run).not.toHaveBeenCalled()
  expect(mock.exit).not.toHaveBeenCalled()
})
