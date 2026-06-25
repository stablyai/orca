export type MobileFilePreviewParamValue = string | string[] | undefined

export type MobileFilePreviewRouteParams = {
  hostId: string
  worktreeId: string
  relativePath: string
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
  if (!hostId || !worktreeId || !relativePath) {
    return { ok: false, message: 'Unable to load preview' }
  }
  return {
    ok: true,
    params: {
      hostId,
      worktreeId,
      relativePath,
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
  return relativePath.split(/[\\/]/).filter(Boolean).at(-1) ?? relativePath
}
