import { parse as parseToml } from 'smol-toml'

// smol-toml accepts a leading BOM, so callers need not strip one first.
export function isLoadableToml(content: string): boolean {
  try {
    parseToml(content)
    return true
  } catch {
    return false
  }
}
