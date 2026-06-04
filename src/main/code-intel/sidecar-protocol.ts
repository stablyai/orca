import type {
  CodeIntelMethod,
  CodeIntelRequest,
  CodeIntelResult
} from '../../shared/code-intel-contract'

export type SidecarMethod = CodeIntelMethod

export type SidecarRequest =
  | { id: number; kind: 'query'; method: SidecarMethod; params: CodeIntelRequest }
  | { id: number; kind: 'cancel' }

export type SidecarResponse =
  | { id: number; ok: true; result: CodeIntelResult }
  | { id: number; ok: false; error: { code: string; message: string } }

export function isSidecarResponse(value: unknown): value is SidecarResponse {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const v = value as Record<string, unknown>
  return typeof v.id === 'number' && typeof v.ok === 'boolean'
}
