import { marked } from 'marked'
import { buildImageDataUri } from '../../shared/image-data-uri'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { execFileCapture } from '../git/command-runner/exec-file-capture'
import { redirectPortedHostnameToEnv } from '../git/command-runner/glab-exec-file'
import { resolveCommand } from '../git/command-runner/wsl-command-resolution'
import { glabRepoExecOptions, type LocalGitExecOptions, type ProjectRef } from './gl-utils'
import { encodedProject } from './project-path-encoding'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_IMAGES = 16

/** Resolve only uploads belonging to the selected GitLab project. */
export function gitLabUploadPath(src: string, project: ProjectRef): string | null {
  let pathname = src
  if (/^https?:\/\//i.test(src)) {
    let url: URL
    try {
      url = new URL(src)
    } catch {
      return null
    }
    if (url.host !== project.host || url.username || url.password || url.search || url.hash) {
      return null
    }
    pathname = url.pathname
  }
  const projectPrefix = `/${project.path}/uploads/`
  if (pathname.startsWith(projectPrefix)) {
    pathname = `/uploads/${pathname.slice(projectPrefix.length)}`
  }
  const match = /^\/uploads\/([a-f0-9]{32})\/([^/?#]+)$/i.exec(pathname)
  if (!match) {
    return null
  }
  try {
    const filename = decodeURIComponent(match[2])
    if (
      /[\\/]/.test(filename) ||
      [...filename].some((char) => char.charCodeAt(0) < 32) ||
      filename === '.' ||
      filename === '..'
    ) {
      return null
    }
    return `projects/${encodedProject(project.path)}/uploads/${match[1]}/${encodeURIComponent(filename)}`
  } catch {
    return null
  }
}

/** Extract preview destinations while leaving Markdown code and ordinary links alone. */
export function collectGitLabImages(contents: readonly string[]): string[] {
  const urls = new Set<string>()
  for (const content of contents) {
    marked.walkTokens(marked.lexer(content), (token) => {
      if (token.type === 'image') {
        urls.add(token.href)
      }
      if (token.type === 'html') {
        for (const match of token.text.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
          const attributes = match[0].slice(4, -1)
          for (const attribute of attributes.matchAll(
            /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
          )) {
            if (attribute[1].toLowerCase() === 'src') {
              urls.add(attribute[2] ?? attribute[3] ?? attribute[4] ?? '')
              break
            }
          }
        }
      }
    })
  }
  return [...urls]
}

/** Reject login pages and active formats before creating a raster preview. */
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return 'image/jpeg'
  }
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    return 'image/gif'
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

/** Load authenticated previews within a shared deadline and serialized response budget. */
export async function loadGitLabImages(
  contents: readonly string[],
  repoPath: string,
  project: ProjectRef,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  maxTotalBytes = MAX_TOTAL_BYTES
): Promise<Record<string, string>> {
  const budget = Math.min(MAX_TOTAL_BYTES, maxTotalBytes)
  if (budget <= 0) {
    return {}
  }
  const paths = new Map<string, string[]>()
  for (const src of collectGitLabImages(contents)) {
    const path = gitLabUploadPath(src, project)
    if (!path) {
      continue
    }
    const aliases = paths.get(path)
    if (aliases) {
      aliases.push(src)
    } else if (paths.size < MAX_IMAGES) {
      paths.set(path, [src])
    }
  }
  const sources: Record<string, string> = {}
  let total = 0
  const signal = AbortSignal.timeout(15_000)
  await mapWithConcurrency([...paths], 3, async ([path, aliases]) => {
    if (signal.aborted || total >= budget) {
      return
    }
    try {
      const { args, options } = redirectPortedHostnameToEnv(
        ['api', '--hostname', project.host, path],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      const command = resolveCommand('glab', args, options.cwd, options.wslDistro)
      // Binary capture is essential: the normal glab runner decodes stdout as UTF-8.
      const { stdout } = await execFileCapture(command.binary, command.args, {
        cwd: command.cwd,
        env: options.env,
        encoding: 'buffer',
        maxBuffer: MAX_IMAGE_BYTES,
        timeout: 15_000,
        signal
      })
      if (!Buffer.isBuffer(stdout) || stdout.length > MAX_IMAGE_BYTES) {
        return
      }
      const dataUrl = buildImageDataUri(imageMime(stdout), stdout.toString('base64'))
      if (!dataUrl) {
        return
      }
      for (const src of aliases) {
        // Each alias is serialized separately in the work-item response.
        const entryBytes = Buffer.byteLength(JSON.stringify(src)) + dataUrl.length + 4
        if (total + entryBytes > budget) {
          break
        }
        total += entryBytes
        sources[src] = dataUrl
      }
    } catch {
      // A missing or inaccessible attachment must not hide the issue itself.
    }
  })
  return sources
}
