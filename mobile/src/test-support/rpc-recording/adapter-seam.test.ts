import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOUNTED_OPERATION_MODULES } from './adapters/mounted-operation-modules'
import {
  HOST_CLIENT_CONTEXT_LOCAL,
  hostClientContextExposure
} from './host-client-context-exposure'

const root = resolve(import.meta.dirname, '../../../..')
const engine = resolve(import.meta.dirname)
const directory = join(engine, 'adapters')
/** The register is the seam's own index, not an adapter. */
const REGISTER = 'mounted-operation-modules.ts'
const sources = MOUNTED_OPERATION_MODULES.map((module) => module.source)

describe('the adapter directory', () => {
  // A module left out of the register mounts nothing, so its scenarios fail as unknown operations.
  it('registers every file in the adapter directory', () => {
    const present = readdirSync(directory).filter((file) => file !== REGISTER)
    expect(present.sort()).toEqual([...sources].sort())
  })

  it('keeps the host-client context exposure in one place, still anchored on the product source', () => {
    // The exposure reaches for a module-private local by name, which no type checker follows: a
    // rename lands as a `ReferenceError` several seconds into a recording. One copy, asserted
    // against the declaration it names, turns that into one failure that says what moved.
    const [, source] = hostClientContextExposure
    const declaration = `const ${HOST_CLIENT_CONTEXT_LOCAL} = createContext`
    const context = readFileSync(join(root, 'mobile/src/transport/client-context.tsx'), 'utf8')
    expect(context.split(declaration).length - 1).toBe(1)
    // Sources only, since the README quotes the string to document it.
    const copies = [engine, directory]
      .flatMap((from) =>
        readdirSync(from, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
          .map((entry) => join(from, entry.name))
      )
      .filter((file) => readFileSync(file, 'utf8').includes(source.trim()))
      .map((file) => relative(root, file))
      .sort()
    expect(copies).toEqual([])
  })
})
