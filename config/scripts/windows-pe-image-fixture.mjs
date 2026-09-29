import { createRequire } from 'node:module'

const { PE_MACHINE } = createRequire(import.meta.url)('./windows-pe-machine.cjs')

/**
 * A PE image with nothing in it but a readable `IMAGE_FILE_HEADER.Machine`.
 *
 * Fixtures need this because the Windows addon gates read the binary: one that
 * is not a PE cannot stand in for an addon whose architecture decides whether
 * the app loads it at all.
 */
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
