'use strict'

const { closeSync, openSync, readSync } = require('node:fs')

/** PE `IMAGE_FILE_HEADER.Machine` values, so a cross-build cannot silently emit host arch. */
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }

// Return null for truncated/non-PE input so caller can classify external artifact instead of crashing.
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

function describePeMachine(machine) {
  return machine === null ? 'not a PE image' : `machine 0x${machine.toString(16)}`
}

module.exports = { PE_MACHINE, describePeMachine, readPeMachine }
