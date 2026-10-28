import { createRequire } from 'node:module'

const { PE_MACHINE } = createRequire(import.meta.url)('./windows-pe-machine.cjs')

// Give fixture real PE machine header: architecture determines whether loader reaches an addon, so arbitrary bytes cannot model it.
export function peImage({ arch = 'x64', machine, peOffset = 0x80, signature = 'PE\0\0' } = {}) {
  if (machine === undefined && PE_MACHINE[arch] === undefined) {
    throw new Error(`No PE machine value for ${arch}; a fixture must not invent one.`)
  }
  const image = Buffer.alloc(peOffset + 8)
  image.write('MZ', 0, 'latin1')
  image.writeUInt32LE(peOffset, 0x3c)
  image.write(signature, peOffset, 'latin1')
  image.writeUInt16LE(machine ?? PE_MACHINE[arch], peOffset + 4)
  return image
}
