import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'

type Respond = (response: RpcResponse) => void
type Success = (id: string, result: unknown, streaming?: boolean) => RpcResponse
type ErrorResponse = (id: string, code: string, message: string) => RpcResponse

const MOCK_IMAGE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8sm7wAAAABJRU5ErkJggg=='

const MOCK_ROOT_PATH = '/tmp/orca-mobile-repro/orca'

const MOCK_FILE_CONTENT: Record<string, string> = {
  'README.md': '# Mobile preview\n\nThis markdown file is served by the mock desktop.',
  'src/app.ts': "export const mobilePreview = 'ready'\n",
  'public/index.html': '<main><h1>Mobile preview</h1><p>HTML preview is ready.</p></main>'
}

const MOCK_FILE_LIST = [
  { relativePath: 'README.md', basename: 'README.md', kind: 'text' },
  { relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' },
  { relativePath: 'public/index.html', basename: 'index.html', kind: 'text' },
  { relativePath: 'artifacts/screenshot.png', basename: 'screenshot.png', kind: 'binary' },
  { relativePath: 'assets/logo.png', basename: 'logo.png', kind: 'binary' },
  { relativePath: 'dist/archive.zip', basename: 'archive.zip', kind: 'binary' }
]

const MOCK_FILE_PATHS = new Set([
  ...Object.keys(MOCK_FILE_CONTENT),
  ...MOCK_FILE_LIST.map((entry) => entry.relativePath)
])

function resolveMockTerminalPath(pathText: string): string | null {
  const normalized = pathText.replace(/\\/g, '/').replace(/^\.\//, '')
  const rootPrefix = `${MOCK_ROOT_PATH}/`
  const relativePath = normalized.startsWith(rootPrefix)
    ? normalized.slice(rootPrefix.length)
    : normalized

  if (relativePath.startsWith('/') || relativePath.includes('../') || relativePath === '..') {
    return null
  }
  return MOCK_FILE_PATHS.has(relativePath) ? relativePath : null
}

export function handleMockFilePreviewRequest(
  request: RpcRequest,
  respond: Respond,
  success: Success,
  error: ErrorResponse
): boolean {
  switch (request.method) {
    case 'files.list':
      respond(
        success(request.id, {
          worktree: request.params?.worktree ?? 'id:mock',
          rootPath: '/tmp/orca-mobile-repro/orca',
          files: MOCK_FILE_LIST,
          totalCount: MOCK_FILE_LIST.length,
          truncated: false
        })
      )
      return true

    case 'files.read': {
      const relativePath = String(request.params?.relativePath ?? '')
      const content = MOCK_FILE_CONTENT[relativePath]
      if (content == null) {
        respond(error(request.id, 'not_found', 'File not found'))
        return true
      }
      respond(
        success(request.id, {
          worktree: request.params?.worktree ?? 'id:mock',
          relativePath,
          content,
          truncated: false,
          byteLength: Buffer.byteLength(content, 'utf8')
        })
      )
      return true
    }

    case 'files.resolveTerminalPath': {
      const pathText = String(request.params?.pathText ?? '')
      const relativePath = resolveMockTerminalPath(pathText)
      respond(
        success(request.id, {
          worktree: request.params?.worktree ?? 'id:mock',
          relativePath,
          absolutePath: relativePath ? `${MOCK_ROOT_PATH}/${relativePath}` : null,
          exists: relativePath !== null,
          isDirectory: false
        })
      )
      return true
    }

    case 'files.readPreview': {
      const relativePath = String(request.params?.relativePath ?? '')
      if (relativePath !== 'assets/logo.png' && relativePath !== 'artifacts/screenshot.png') {
        respond(error(request.id, 'binary_file', 'binary_file'))
        return true
      }
      respond(
        success(request.id, {
          content: MOCK_IMAGE_PNG_BASE64,
          isBinary: true,
          isImage: true,
          mimeType: 'image/png'
        })
      )
      return true
    }

    default:
      return false
  }
}
