'use strict'

const { closeSync, openSync, readSync } = require('node:fs')

/** PE `IMAGE_FILE_HEADER.Machine` values, so a cross-build cannot silently emit host arch. */
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }

/**
 * `IMAGE_FILE_HEADER.Machine`, or null when the file is not a PE image.
 *
 * Null rather than a throw because callers ask this of files they did not
 * produce: a truncated or non-PE binary is a thing to decide about, not a crash.
 */
function readPeMachine(binaryPath) {
  const fd = openSync(binaryPath, 'r')
  try {
    const dosHeader = Buffer.alloc(0x40)
    if (readSync(fd, dosHeader, 0, 0x40, 0) < 0x40 || dosHeader.toString('latin1', 0, 2) !== 'MZ') {
      return null
    }
    const peOffset = dosHeader.readUInt32LE(0x3c)
    const peHeader = Buffer.alloc(6)
    if (
      readSync(fd, peHeader, 0, 6, peOffset) < 6 ||
      peHeader.toString('latin1', 0, 4) !== 'PE\0\0'
    ) {
      return null
    }
    return peHeader.readUInt16LE(4)
  } finally {
    closeSync(fd)
  }
}

/** How to name a machine field in an error, including the file that has none. */
function describePeMachine(machine) {
  return machine === null ? 'not a PE image' : `machine 0x${machine.toString(16)}`
}

module.exports = { PE_MACHINE, describePeMachine, readPeMachine }
