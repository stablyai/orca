export type MobileFilePreviewParamValue = string | string[] | undefined

export type MobileFilePreviewRouteParams = {
  hostId: string
  worktreeId: string
  relativePath?: string
  source?: 'worktree' | 'terminalArtifact'
  absolutePath?: string
  grantId?: string
  terminal?: string
  pathText?: string
  cwd?: string
  line?: string
  column?: string
  name?: string
  worktreeName?: string
}

export type MobileFilePreviewRouteState =
  | { ok: true; params: MobileFilePreviewRouteParams }
  | { ok: false; message: string }

export type MobileFilePreviewHref = {
  pathname: '/h/[hostId]/files/preview/[worktreeId]'
  params: MobileFilePreviewRouteParams
}

type RawPreviewRouteParams = {
  hostId?: MobileFilePreviewParamValue
  worktreeId?: MobileFilePreviewParamValue
  relativePath?: MobileFilePreviewParamValue
  source?: MobileFilePreviewParamValue
  absolutePath?: MobileFilePreviewParamValue
  grantId?: MobileFilePreviewParamValue
  terminal?: MobileFilePreviewParamValue
  pathText?: MobileFilePreviewParamValue
  cwd?: MobileFilePreviewParamValue
  line?: MobileFilePreviewParamValue
  column?: MobileFilePreviewParamValue
  name?: MobileFilePreviewParamValue
  worktreeName?: MobileFilePreviewParamValue
}

function singleParam(value: MobileFilePreviewParamValue): string | null {
  return typeof value === 'string' ? value : null
}

function optionalSingleParam(value: MobileFilePreviewParamValue): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function normalizeMobileFilePreviewRouteParams(
  params: RawPreviewRouteParams
): MobileFilePreviewRouteState {
  const hostId = singleParam(params.hostId)
  const worktreeId = singleParam(params.worktreeId)
  const relativePath = singleParam(params.relativePath)
  const source = singleParam(params.source)
  const absolutePath = singleParam(params.absolutePath)
  const grantId = singleParam(params.grantId)
  if (!hostId || !worktreeId) {
    return { ok: false, message: 'Unable to load preview' }
  }
  if (source === 'terminalArtifact') {
    if (!absolutePath || !grantId) {
      return { ok: false, message: 'Unable to load preview' }
    }
    return {
      ok: true,
      params: {
        hostId,
        worktreeId,
        source,
        absolutePath,
        grantId,
        terminal: optionalSingleParam(params.terminal),
        pathText: optionalSingleParam(params.pathText),
        cwd: optionalSingleParam(params.cwd),
        line: optionalSingleParam(params.line),
        column: optionalSingleParam(params.column),
        name: optionalSingleParam(params.name),
        worktreeName: optionalSingleParam(params.worktreeName)
      }
    }
  }
  if (!relativePath) {
    return { ok: false, message: 'Unable to load preview' }
  }
  return {
    ok: true,
    params: {
      hostId,
      worktreeId,
      relativePath,
      source: 'worktree',
      line: optionalSingleParam(params.line),
      column: optionalSingleParam(params.column),
      name: optionalSingleParam(params.name),
      worktreeName: optionalSingleParam(params.worktreeName)
    }
  }
}

export function createMobileFilePreviewHref(
  params: MobileFilePreviewRouteParams
): MobileFilePreviewHref {
  return {
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    params
  }
}

export function displayNameFromPreviewPath(relativePath: string): string {
  return relativePath.split(/[\\/]/).findLast(Boolean) ?? relativePath
}
