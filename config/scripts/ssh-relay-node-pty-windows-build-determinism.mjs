import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const COMPILER_OPTIONS = `            'VCCLCompilerTool': {
              'AdditionalOptions': [
                '/guard:cf',
                '/sdl',
                '/W3',
                '/w34244',
                '/w34267',
                '/ZH:SHA_256'
              ]
            }`

const REPRODUCIBLE_COMPILER_OPTIONS = `            'VCCLCompilerTool': {
              'AdditionalOptions': [
                '/guard:cf',
                '/sdl',
                '/W3',
                '/w34244',
                '/w34267',
                '/ZH:SHA_256',
                '/Brepro',
                '/experimental:deterministic'
              ]
            }`

const LINKER_OPTIONS = `            'VCLinkerTool': {
              'AdditionalOptions': [
                '/DYNAMICBASE',
                '/guard:cf'
              ]
            }`

const REPRODUCIBLE_LINKER_OPTIONS = `            'VCLinkerTool': {
              'AdditionalOptions': [
                '/DYNAMICBASE',
                '/guard:cf',
                '/INCREMENTAL:NO',
                '/Brepro',
                '/experimental:deterministic'
              ]
            }`

const REQUIRED_COMPILER_OPTIONS = ['/Brepro', '/experimental:deterministic']
const REQUIRED_LINKER_OPTIONS = [...REQUIRED_COMPILER_OPTIONS, '/INCREMENTAL:NO']
const MAX_LINK_COMMAND_TRACKING_BYTES = 256 * 1024
const MAX_LINK_COMMAND_TRACKING_CANDIDATES = 32
const MAX_LINK_COMMAND_TRACKING_DEPTH = 8
const MAX_LINK_COMMAND_TRACKING_ENTRIES = 10_000
const TARGET_LINK_OUTPUT_PATTERN = /(?:^|[\\/:"'\s])conpty_console_list\.node(?=$|[\\/:"'\s])/i

function decodeXmlText(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function releaseDefinitionGroup(source, configuration) {
  const expectedCondition = `'Release|${configuration}'`.toLowerCase()
  const groups = [
    ...source.matchAll(/<ItemDefinitionGroup\b([^>]*)>([\s\S]*?)<\/ItemDefinitionGroup>/g)
  ].filter((match) => {
    // Why: native arm64 MSBuild uses lowercase `arm64`; platform identities are case-insensitive.
    return decodeXmlText(match[1]).toLowerCase().includes(expectedCondition)
  })
  if (groups.length !== 1) {
    throw new Error('generated MSBuild settings lack one exact Release configuration')
  }
  return groups[0][2]
}

function requiredToolOptions(group, tool, requiredOptions) {
  const tools = [...group.matchAll(new RegExp(`<${tool}\\b[^>]*>([\\s\\S]*?)</${tool}>`, 'g'))]
  const options = tools.flatMap((match) => [
    ...match[1].matchAll(/<AdditionalOptions\b[^>]*>([\s\S]*?)<\/AdditionalOptions>/g)
  ])
  if (tools.length !== 1 || options.length !== 1) {
    throw new Error(`generated MSBuild settings lack one exact ${tool} option block`)
  }
  const tokens = decodeXmlText(options[0][1]).trim().split(/\s+/)
  if (!tokens.includes('%(AdditionalOptions)')) {
    throw new Error(`generated MSBuild settings do not inherit ${tool} options`)
  }
  for (const required of requiredOptions) {
    const count = tokens.filter((token) => token.toLowerCase() === required.toLowerCase()).length
    if (count !== 1) {
      throw new Error(`generated MSBuild settings require exactly one ${tool} ${required}`)
    }
  }
  return [...requiredOptions]
}

export async function applyWindowsNodePtyBuildDeterminism({ nodePtyDirectory, tuple }) {
  if (!tuple.startsWith('win32-')) {
    return false
  }
  const bindingPath = join(nodePtyDirectory, 'binding.gyp')
  const source = await readFile(bindingPath, 'utf8')
  if (
    source.split(COMPILER_OPTIONS).length !== 2 ||
    source.split(LINKER_OPTIONS).length !== 2 ||
    source.includes("'/Brepro'") ||
    source.includes("'/INCREMENTAL:NO'") ||
    source.includes("'/experimental:deterministic'")
  ) {
    throw new Error('node-pty Windows build settings do not match the reviewed source')
  }
  // Why: ARM64 needs both reproducible stages, while /DEBUG-implied incremental thunks still drift.
  // Keep this producer correction inside the exclusive copied artifact source.
  const reproducibleSource = source
    .replace(COMPILER_OPTIONS, REPRODUCIBLE_COMPILER_OPTIONS)
    .replace(LINKER_OPTIONS, REPRODUCIBLE_LINKER_OPTIONS)
  await writeFile(bindingPath, reproducibleSource, 'utf8')
  return true
}

export async function assertWindowsNodePtyGeneratedBuildSettings({ nodePtyDirectory, tuple }) {
  if (!tuple.startsWith('win32-')) {
    return undefined
  }
  const project = 'conpty_console_list.vcxproj'
  const configuration = `Release|${tuple.endsWith('-arm64') ? 'ARM64' : 'x64'}`
  const source = await readFile(join(nodePtyDirectory, 'build', project), 'utf8')
  const group = releaseDefinitionGroup(source, configuration.split('|')[1])
  // Why: the source rewrite is insufficient proof unless gyp propagates both stages into MSBuild.
  return {
    configuration,
    compilerOptions: requiredToolOptions(group, 'ClCompile', REQUIRED_COMPILER_OPTIONS),
    linkerOptions: requiredToolOptions(group, 'Link', REQUIRED_LINKER_OPTIONS),
    project
  }
}

async function readBoundedLinkCommandTracking(path) {
  const handle = await open(path, 'r')
  try {
    // Why: build-tool tracking output must not bypass the diagnostic's explicit memory ceiling.
    const bytes = Buffer.allocUnsafe(MAX_LINK_COMMAND_TRACKING_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null)
      if (result.bytesRead === 0) {
        break
      }
      length += result.bytesRead
    }
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}

async function discoverLinkCommandTracking(nodePtyDirectory) {
  // Why: generated dependency projects live elsewhere; only Release contains target link outputs.
  const queue = [{ depth: 0, path: join(nodePtyDirectory, 'build', 'Release') }]
  const candidates = []
  const incrementalDatabases = []
  let entries = 0
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const children = await readdir(current.path, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      entries += 1
      if (entries > MAX_LINK_COMMAND_TRACKING_ENTRIES) {
        throw new Error('MSBuild linker tracking discovery exceeds the bounded entry count')
      }
      if (child.isSymbolicLink()) {
        throw new Error('MSBuild linker tracking discovery rejects symbolic links')
      }
      const childPath = join(current.path, child.name)
      if (child.isDirectory()) {
        if (current.depth >= MAX_LINK_COMMAND_TRACKING_DEPTH) {
          throw new Error('MSBuild linker tracking discovery exceeds the bounded depth')
        }
        queue.push({ depth: current.depth + 1, path: childPath })
      } else if (child.isFile() && child.name.toLowerCase() === 'link.command.1.tlog') {
        candidates.push(childPath)
        if (candidates.length > MAX_LINK_COMMAND_TRACKING_CANDIDATES) {
          throw new Error('MSBuild linker tracking discovery has too many candidates')
        }
      } else if (child.isFile() && child.name.toLowerCase() === 'conpty_console_list.ilk') {
        incrementalDatabases.push(childPath)
        if (incrementalDatabases.length > 1) {
          throw new Error('MSBuild incremental database discovery has duplicate target files')
        }
      }
    }
  }
  return { candidates, entries, incrementalDatabases }
}

function decodeLinkCommandTracking(bytes) {
  if (bytes.length < 2 || bytes.length > MAX_LINK_COMMAND_TRACKING_BYTES) {
    throw new Error('MSBuild linker tracking record is outside the bounded size')
  }
  let encoding = 'utf8'
  let offset = 0
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf16le'
    offset = 2
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3
  }
  let text
  try {
    const decoderEncoding = encoding === 'utf16le' ? 'utf-16le' : 'utf-8'
    text = new TextDecoder(decoderEncoding, { fatal: true }).decode(bytes.subarray(offset))
  } catch {
    throw new Error('MSBuild linker tracking record has invalid text encoding')
  }
  if (text.includes('\u0000') || text.includes('\ufffd')) {
    throw new Error('MSBuild linker tracking record has invalid text encoding')
  }
  return { encoding, text }
}

export function parseWindowsNodePtyLinkCommandTracking(bytes) {
  const { encoding, text } = decodeLinkCommandTracking(bytes)
  const commandRecords = text.split(/\r?\n/).filter((line) => line.startsWith('^')).length
  if (commandRecords !== 1) {
    throw new Error('MSBuild linker tracking record must contain exactly one command record')
  }
  const switches = [
    ...text.matchAll(
      /(?:^|\s)(\/(?:brepro|debug(?::[^\s"]+)?|experimental:deterministic|guard:[^\s"]+|incremental(?::(?:no|yes))?|opt:[^\s"]+))(?=\s|$)/gim
    )
  ].map((match) => match[1].toLowerCase())
  const incrementalTokens = [
    ...text.matchAll(/(?:^|\s)(\/incremental(?::[^\s"]*)?)(?=\s|$)/gim)
  ].map((match) => match[1].toLowerCase())
  if (incrementalTokens.some((token) => !switches.includes(token))) {
    throw new Error('MSBuild linker tracking record has malformed incremental-link switch')
  }
  if (new Set(switches).size !== switches.length) {
    throw new Error('MSBuild linker tracking record has duplicate allowlisted switches')
  }
  for (const required of ['/brepro', '/experimental:deterministic', '/guard:cf']) {
    if (!switches.includes(required)) {
      throw new Error(`MSBuild linker tracking record is missing ${required}`)
    }
  }
  const incrementalSwitches = switches.filter((value) => value.startsWith('/incremental'))
  if (incrementalSwitches.length > 1) {
    throw new Error('MSBuild linker tracking record has ambiguous incremental-link switches')
  }
  const incremental =
    incrementalSwitches.length === 0
      ? 'unspecified'
      : incrementalSwitches[0] === '/incremental:no'
        ? 'disabled'
        : 'enabled'
  return {
    bytes: bytes.length,
    commandRecords,
    encoding,
    incremental,
    switches: switches.toSorted()
  }
}

export async function inspectWindowsNodePtyLinkCommandTracking({ nodePtyDirectory, tuple }) {
  if (!tuple.startsWith('win32-')) {
    return undefined
  }
  const discovery = await discoverLinkCommandTracking(nodePtyDirectory)
  const matching = []
  for (const path of discovery.candidates) {
    const bytes = await readBoundedLinkCommandTracking(path)
    if (TARGET_LINK_OUTPUT_PATTERN.test(decodeLinkCommandTracking(bytes).text)) {
      matching.push(bytes)
    }
  }
  if (matching.length !== 1) {
    throw new Error(
      `MSBuild linker tracking discovery requires exactly one target command file (candidates=${discovery.candidates.length}, matches=${matching.length}, entries=${discovery.entries})`
    )
  }
  // Why: /DEBUG can imply incremental linking without spelling /INCREMENTAL in the command record.
  let incrementalDatabase = { state: 'absent' }
  if (discovery.incrementalDatabases.length === 1) {
    const bytes = (await stat(discovery.incrementalDatabases[0])).size
    incrementalDatabase = { bytes, state: 'present' }
  }
  const linkCommand = parseWindowsNodePtyLinkCommandTracking(matching[0])
  if (linkCommand.incremental !== 'disabled' || incrementalDatabase.state !== 'absent') {
    throw new Error('MSBuild incremental linking must be disabled without a target database')
  }
  return {
    ...linkCommand,
    candidateFiles: discovery.candidates.length,
    incrementalDatabase,
    searchedEntries: discovery.entries
  }
}
