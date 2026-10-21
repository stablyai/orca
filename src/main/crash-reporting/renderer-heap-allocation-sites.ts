import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'

const MAX_SITES = 12
const MAX_STACK_FRAMES = 4
const MAX_FUNCTION_NAME_LENGTH = 48
const MAX_FILE_NAME_LENGTH = 64
// Why: crumb strings are cut at 240 characters; whole caller frames are dropped first, never half of one.
const MAX_STACK_TEXT_LENGTH = 225
const BUNDLE_FILE_NAME = /^[\w.-]+\.[cm]?js$/
const CODE_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/
// V8's own runtime frames (no script) report fixed parenthesized labels such as "(GC)" or "(V8 API)".
const RUNTIME_LABEL = /^\([A-Za-z0-9 _-]{1,24}\)$/

type CallFrame = {
  functionName: string
  url: string
  scriptId: string
  lineNumber: number
  columnNumber: number
}
type SamplingProfileNode = {
  callFrame: CallFrame
  selfSize: number
  children?: SamplingProfileNode[]
}
export type SamplingProfile = { head: SamplingProfileNode }

/**
 * Top allocation sites by sampled live bytes, as `KB fn@file:line:col < caller@file:line:col`.
 * Only frames from the window's own bundle (`trustedScriptPrefix`) and V8 builtins keep a name;
 * every other frame becomes a fixed label, so no user-derived name, path or content can leak.
 */
export function summarizeSamplingProfile(
  profile: SamplingProfile,
  trustedScriptPrefix: string | null
): CrashReportBreadcrumbData {
  const describe = (node: SamplingProfileNode): string =>
    describeFrame(node.callFrame, trustedScriptPrefix)
  const sites = new Map<string, number>()
  let totalBytes = 0
  const walk: { node: SamplingProfileNode; stack: SamplingProfileNode[] }[] = [
    { node: profile.head, stack: [] }
  ]
  for (let item = walk.pop(); item; item = walk.pop()) {
    const { node, stack } = item
    const frames = node === profile.head ? stack : [node, ...stack].slice(0, MAX_STACK_FRAMES)
    if (node.selfSize > 0 && frames.length > 0) {
      totalBytes += node.selfSize
      const key = joinFrames(frames.map(describe))
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize)
    }
    for (const child of node.children ?? []) {
      walk.push({ node: child, stack: frames })
    }
  }
  const top = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SITES)
  const data: CrashReportBreadcrumbData = {
    sampledLiveMB: Math.round(totalBytes / (1024 * 1024)),
    siteCount: sites.size
  }
  top.forEach(([key, bytes], index) => {
    data[`site${String(index + 1).padStart(2, '0')}`] = `${Math.round(bytes / 1024)}KB ${key}`
  })
  return data
}

function joinFrames(described: string[]): string {
  let text = described[0] ?? ''
  for (const frame of described.slice(1)) {
    if (text.length + 3 + frame.length > MAX_STACK_TEXT_LENGTH) {
      break
    }
    text += ` < ${frame}`
  }
  return text
}

function describeFrame(frame: CallFrame, trustedScriptPrefix: string | null): string {
  const { functionName, url, scriptId, lineNumber, columnNumber } = frame
  if (!url) {
    // Why scriptId '0': eval'd code also has no URL but gets a real script id and user-derived names.
    if (scriptId !== '0') {
      return '(other script)'
    }
    if (RUNTIME_LABEL.test(functionName)) {
      return functionName
    }
    return CODE_IDENTIFIER.test(functionName) && functionName.length <= MAX_FUNCTION_NAME_LENGTH
      ? functionName
      : '(native)'
  }
  const fileName = url.slice(trustedScriptPrefix?.length ?? 0)
  if (
    !trustedScriptPrefix ||
    !url.startsWith(trustedScriptPrefix) ||
    !BUNDLE_FILE_NAME.test(fileName) ||
    fileName.length > MAX_FILE_NAME_LENGTH
  ) {
    return '(other script)'
  }
  // Why replace rather than strip: stripping characters would hide secrets from the report redactor.
  const name =
    CODE_IDENTIFIER.test(functionName) && functionName.length <= MAX_FUNCTION_NAME_LENGTH
      ? functionName
      : '(anonymous)'
  return `${name}@${fileName}:${lineNumber + 1}:${columnNumber + 1}`
}

/** The bundle folder next to the window's page, e.g. `file:///…/out/renderer/assets/`; null if unknown. */
export function trustedScriptPrefixFor(pageUrl: string): string | null {
  try {
    const prefix = new URL('assets/', pageUrl)
    return ['file:', 'http:', 'https:'].includes(prefix.protocol) ? prefix.href : null
  } catch {
    return null
  }
}

export function readSamplingProfile(result: unknown): SamplingProfile | null {
  if (!result || typeof result !== 'object' || !('profile' in result)) {
    return null
  }
  const { profile } = result
  if (!profile || typeof profile !== 'object' || !('head' in profile)) {
    return null
  }
  const { head } = profile
  return isSamplingProfileNode(head) ? { head } : null
}

function isSamplingProfileNode(value: unknown): value is SamplingProfileNode {
  if (!value || typeof value !== 'object' || !('callFrame' in value) || !('selfSize' in value)) {
    return false
  }
  const { callFrame, selfSize } = value
  return (
    typeof selfSize === 'number' &&
    !!callFrame &&
    typeof callFrame === 'object' &&
    'functionName' in callFrame &&
    typeof callFrame.functionName === 'string' &&
    'url' in callFrame &&
    typeof callFrame.url === 'string' &&
    'scriptId' in callFrame &&
    typeof callFrame.scriptId === 'string' &&
    'lineNumber' in callFrame &&
    typeof callFrame.lineNumber === 'number' &&
    'columnNumber' in callFrame &&
    typeof callFrame.columnNumber === 'number'
  )
}
