const { copyFileSync, mkdirSync, openSync, closeSync, readSync, rmSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const WINDOWS_MACHINE_BY_ARCH = {
  arm64: 0xaa64,
  x64: 0x8664
}

const NODE_PTY_WINDOWS_RUNTIME_FILES = [
  'conpty.node',
  'conpty_console_list.node',
  'pty.node',
  'winpty-agent.exe',
  'winpty.dll',
  join('conpty', 'conpty.dll'),
  join('conpty', 'OpenConsole.exe')
]

function readPortableExecutableMachine(filePath) {
  const file = openSync(filePath, 'r')
  try {
    const dosHeader = Buffer.alloc(64)
    if (readSync(file, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      throw new Error(`PE file is too small: ${filePath}`)
    }
    if (dosHeader.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`PE file is missing its MZ header: ${filePath}`)
    }

    const peOffset = dosHeader.readUInt32LE(0x3c)
    const peHeader = Buffer.alloc(6)
    if (readSync(file, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error(`PE header is truncated: ${filePath}`)
    }
    if (peHeader.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`PE signature is invalid: ${filePath}`)
    }
    return peHeader.readUInt16LE(4)
  } finally {
    closeSync(file)
  }
}

function stageWindowsNodePtyPrebuild(projectDir, architecture) {
  const expectedMachine = WINDOWS_MACHINE_BY_ARCH[architecture]
  if (!expectedMachine) {
    throw new Error(`Unsupported Windows node-pty architecture: ${architecture}`)
  }

  const nodePtyDir = resolve(projectDir, 'node_modules', 'node-pty')
  const sourceDir = join(nodePtyDir, 'prebuilds', `win32-${architecture}`)
  const releaseDir = join(nodePtyDir, 'build', 'Release')

  for (const relativePath of NODE_PTY_WINDOWS_RUNTIME_FILES) {
    const sourceFile = join(sourceDir, relativePath)
    const machine = readPortableExecutableMachine(sourceFile)
    if (machine !== expectedMachine) {
      throw new Error(
        `Windows node-pty prebuild has machine 0x${machine.toString(16)}; ` +
          `expected ${architecture} (0x${expectedMachine.toString(16)}): ${sourceFile}`
      )
    }
  }

  // Why: node-pty checks build/Release before its target-specific prebuild, so
  // a host-architecture artifact left by install would shadow the ARM64 files.
  rmSync(releaseDir, { recursive: true, force: true })
  for (const relativePath of NODE_PTY_WINDOWS_RUNTIME_FILES) {
    const destination = join(releaseDir, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(sourceDir, relativePath), destination)
  }

  return releaseDir
}

module.exports = {
  NODE_PTY_WINDOWS_RUNTIME_FILES,
  WINDOWS_MACHINE_BY_ARCH,
  readPortableExecutableMachine,
  stageWindowsNodePtyPrebuild
}
