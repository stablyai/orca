const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { gzipSync } = require('node:zlib')

const mobileRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(mobileRoot, '..')
const localesDir = path.join(mobileRoot, 'src', 'i18n', 'locales')
const enRuntimeRequiredPath = path.join(mobileRoot, 'src', 'i18n', 'en-runtime-required.json')
const outputDir = path.join(mobileRoot, 'src', 'i18n', 'locales-compressed')

const BUNDLED_LOCALES = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-Hant']
const RESOLVE_EXTS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.native.ts',
  '.native.tsx',
  '.android.ts',
  '.android.tsx',
  '.ios.ts',
  '.ios.tsx'
]
const IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.\.?\/[^'"]+)['"]|import\s+['"](\.\.?\/[^'"]+)['"]/g
const DOTTED_LITERAL_RE = /['"]([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+)['"]/g
const DYNAMIC_PREFIX_RE = /`([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\.)\$\{/g

function resolveRelativeModules(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base]
  for (const ext of RESOLVE_EXTS) {
    candidates.push(`${base}${ext}`)
  }
  for (const ext of RESOLVE_EXTS) {
    candidates.push(path.join(base, `index${ext}`))
  }
  const found = []
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        found.push(candidate)
      }
    } catch {
      // Try next candidate
    }
  }
  return found
}

function collectNativeAppEntries(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectNativeAppEntries(full, out)
    } else if (
      /\.[tj]sx?$/.test(entry.name) &&
      !/\.(?:web|test)\.[tj]sx?$/.test(entry.name) &&
      !/(?:\+api|\+html|\+middleware)\.[tj]sx?$/.test(entry.name)
    ) {
      out.push(full)
    }
  }
}

function collectNativeKeyFilter() {
  const queue = [path.join(mobileRoot, 'index.js')]
  collectNativeAppEntries(path.join(mobileRoot, 'app'), queue)

  const visited = new Set()
  const exactStrings = new Set()
  const dynamicPrefixes = new Set()

  // Always retain every key present in en-runtime-required.json as a floor.
  const enRequired = JSON.parse(fs.readFileSync(enRuntimeRequiredPath, 'utf8'))
  const addLeaves = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        addLeaves(v, full)
      } else {
        exactStrings.add(full)
        exactStrings.add(full.replace(/_(zero|one|two|few|many|other)$/, ''))
      }
    }
  }
  addLeaves(enRequired, '')

  while (queue.length > 0) {
    const file = queue.pop()
    if (visited.has(file)) {
      continue
    }
    visited.add(file)
    if (!file.startsWith(mobileRoot) && !file.startsWith(path.join(repoRoot, 'src', 'shared'))) {
      continue
    }
    if (file.includes(`${path.sep}node_modules${path.sep}`)) {
      continue
    }
    let src
    try {
      src = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }

    for (const match of src.matchAll(DOTTED_LITERAL_RE)) {
      exactStrings.add(match[1])
    }
    for (const match of src.matchAll(DYNAMIC_PREFIX_RE)) {
      dynamicPrefixes.add(match[1])
    }
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1] || match[2]
      if (!spec || spec.includes('/locales-compressed/') || spec.includes('/locales/')) {
        continue
      }
      for (const resolved of resolveRelativeModules(file, spec)) {
        if (!visited.has(resolved) && !/\.web\.[tj]sx?$/.test(resolved)) {
          queue.push(resolved)
        }
      }
    }
  }

  const filterDigest = crypto
    .createHash('sha256')
    .update([...exactStrings].sort().join('\n'))
    .update('\0')
    .update([...dynamicPrefixes].sort().join('\n'))
    .digest('hex')
    .slice(0, 16)

  return { exactStrings, dynamicPrefixes: [...dynamicPrefixes], filterDigest }
}

function pruneCatalog(obj, prefix, exactStrings, dynamicPrefixes) {
  const out = {}
  let count = 0
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = pruneCatalog(v, full, exactStrings, dynamicPrefixes)
      if (sub.count > 0) {
        out[k] = sub.out
        count += sub.count
      }
    } else {
      const base = full.replace(/_(zero|one|two|few|many|other)$/, '')
      let keep = exactStrings.has(full) || exactStrings.has(base)
      if (!keep) {
        for (const dp of dynamicPrefixes) {
          if (full.startsWith(dp)) {
            keep = true
            break
          }
        }
      }
      if (keep) {
        out[k] = v
        count += 1
      }
    }
  }
  return { out, count }
}

// Keep compressed native-only locale modules in sync with locales/*.json whenever Metro starts or postinstall runs.
function ensureCompressedLocaleCatalogsSync() {
  fs.mkdirSync(outputDir, { recursive: true })
  const { exactStrings, dynamicPrefixes, filterDigest } = collectNativeKeyFilter()
  const filterHeader = `// Native key filter: ${filterDigest}`

  for (const locale of BUNDLED_LOCALES) {
    const srcPath = path.join(localesDir, `${locale}.json`)
    const outPath = path.join(outputDir, `${locale}.generated.ts`)
    const srcStat = fs.statSync(srcPath)
    let needsBuild = true
    try {
      const outStat = fs.statSync(outPath)
      if (outStat.mtimeMs >= srcStat.mtimeMs) {
        const head = fs.readFileSync(outPath, 'utf8').slice(0, 260)
        if (head.includes(filterHeader)) {
          needsBuild = false
        }
      }
    } catch {
      needsBuild = true
    }
    if (!needsBuild) {
      continue
    }
    const raw = fs.readFileSync(srcPath, 'utf8')
    const pruned = pruneCatalog(JSON.parse(raw), '', exactStrings, dynamicPrefixes).out
    const minified = JSON.stringify(pruned)
    const encoded = gzipSync(Buffer.from(minified, 'utf8'), { level: 9 }).toString('base64')
    const source = [
      '// Generated by scripts/build-compressed-locale-catalogs.mjs.',
      `// Source: src/i18n/locales/${locale}.json (native-reachable keys, minified, gzip level 9, base64).`,
      filterHeader,
      '// Do not edit by hand; regenerate via pnpm postinstall or Metro startup.',
      `const catalogGzipBase64 = ${JSON.stringify(encoded)}`,
      'export default catalogGzipBase64',
      ''
    ].join('\n')
    fs.writeFileSync(outPath, source)
  }
}

module.exports = { ensureCompressedLocaleCatalogsSync }
