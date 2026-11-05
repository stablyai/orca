import { readdirSync } from 'node:fs'
import { join } from 'node:path'

// Exclude generated/vendor bundles; source censuses must inspect editable call sites, including generators and original document modules.
export function isGeneratedSource(name: string): boolean {
  return /\.generated\.tsx?$/.test(name)
}

// Share source-boundary rules; each census still decides which extensions and tests matter to its own contract.
export function censusSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : censusSourceFiles(path)
    }
    return isGeneratedSource(entry.name) ? [] : [path]
  })
}
