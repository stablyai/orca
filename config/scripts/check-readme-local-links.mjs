import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Why: the READMEs embed media from trees other jobs own (docs-site public media,
// generated feature-wall tiles), and the docs-only classifier skips the whole CI
// matrix for one of them. GitHub renders only committed files, so this checks the
// git index rather than the working tree.
const TRANSLATED_README_DIR = path.join('docs', 'readme')
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i
const HTML_ATTRIBUTE = /\b(?:src|srcset|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

function readmeFiles(root) {
  const translated = readdirSync(path.join(root, TRANSLATED_README_DIR))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => path.posix.join('docs', 'readme', name))
  return ['README.md', ...translated]
}

// Why only the referenced paths: a full `git ls-files` of this repo overflows the
// default child buffer; asking about a few dozen pathspecs stays bounded.
function trackedFiles(root, candidates) {
  if (candidates.length === 0) {
    return new Set()
  }
  const stdout = execFileSync(
    'git',
    ['--literal-pathspecs', 'ls-files', '-z', '--', ...candidates],
    { cwd: root, encoding: 'utf8' }
  )
  return new Set(stdout.split('\0').filter(Boolean))
}

function* localTargets(markdown) {
  for (const match of markdown.matchAll(HTML_ATTRIBUTE)) {
    // Why: srcset is a candidate list ("a.gif 1x, b.gif 2x"); each entry starts with a URL.
    for (const candidate of (match[1] ?? match[2]).split(',')) {
      const target = candidate.trim().split(/\s+/)[0]
      if (target) {
        yield target
      }
    }
  }
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    yield match[1].replace(/^<|>$/g, '')
  }
}

function resolveTarget(readme, target) {
  const bare = target.split(/[?#]/)[0]
  if (!bare) {
    return null
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(readme), decodeURIComponent(bare))
  )
  return resolved.startsWith('../') ? null : resolved
}

function collectLinks(root) {
  const links = []
  for (const readme of readmeFiles(root)) {
    const markdown = readFileSync(path.join(root, readme), 'utf8')
    for (const target of new Set(localTargets(markdown))) {
      if (EXTERNAL_TARGET.test(target)) {
        continue
      }
      links.push({ readme, target, resolved: resolveTarget(readme, target) })
    }
  }
  return links
}

export function findBrokenReadmeLinks(root) {
  const links = collectLinks(root)
  const candidates = [...new Set(links.map((link) => link.resolved).filter(Boolean))]
  const tracked = trackedFiles(root, candidates)
  return links.filter(({ resolved }) => resolved === null || !tracked.has(resolved))
}

export function main(root = process.cwd()) {
  const broken = findBrokenReadmeLinks(root)
  if (broken.length > 0) {
    console.error(`README local link check failed with ${broken.length} broken link(s):`)
    for (const { readme, target, resolved } of broken) {
      console.error(
        `- ${readme}: ${target} -> ${resolved ?? 'outside the repository'} is not tracked`
      )
    }
    return 1
  }
  console.log('README local link check passed.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
