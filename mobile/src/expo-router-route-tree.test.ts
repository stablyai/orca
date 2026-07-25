import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// expo-router treats every TypeScript file under `app/` as a route, including non-route modules.
const APP_ROOT = path.resolve(__dirname, '../app')

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkRouteFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('expo-router route tree', () => {
  it('holds only files that export a route component', () => {
    const missing = walkRouteFiles(APP_ROOT)
      .filter((file) => !/^export default/m.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(APP_ROOT, file).split(path.sep).join('/'))
      .sort()
    // Why toEqual([]): failures print the exact phantom routes.
    expect(missing).toEqual([])
  })
})
