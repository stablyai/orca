import type { MobileWebTaskProjectTablePayload } from '../../shared/mobile-web/task-project-table-contract'

// Page-side echo check: a project result must name the project the request asked for.
export function sameMobileWebTaskProject(
  result: { owner: string; ownerType: string; number: number; host?: string },
  payload: MobileWebTaskProjectTablePayload
): boolean {
  return (
    result.owner === payload.owner &&
    result.ownerType === payload.ownerType &&
    result.number === payload.number &&
    (result.host ?? 'github.com') === (payload.host ?? 'github.com')
  )
}
