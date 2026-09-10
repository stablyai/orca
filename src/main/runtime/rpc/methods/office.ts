/**
 * Office preview on a paired runtime host.
 *
 * Unlike the SSH relay — bundle-hash-locked to its client — a paired host and its client update
 * independently. The host advertises `office.preview.v1` in `RUNTIME_CAPABILITIES` so a client can
 * see the surface exists, but nothing here gates on it: what a client has to survive is an OLDER
 * host, and an old host has no methods to gate with. The protection that actually runs is on the
 * calling side, where `office-host-dispatch` maps `method_not_found` to "update the paired
 * machine" — the same shape `doc-preview-file-reader` uses for scoped reads, and never a preview
 * that silently does nothing.
 *
 * The host-side work is `executeOfficeMethod`, identical to the local and SSH implementations:
 * `officecli` runs on the machine that owns the document, with that machine's fonts and locale.
 */
import { z } from 'zod'
import {
  isValidOfficeDocumentPath,
  isValidOfficeRelativePath
} from '../../../../shared/office-preview-rpc'
import {
  OFFICE_CLEAR_MARKS_METHOD,
  OFFICE_GOTO_METHOD,
  OFFICE_MARKS_METHOD,
  OFFICE_PROBE_METHOD,
  OFFICE_RENDER_METHOD,
  OFFICE_SELECTION_METHOD,
  OFFICE_SKILLS_INSTALL_METHOD,
  OFFICE_SKILLS_LIST_METHOD,
  OFFICE_WATCH_REFRESH_METHOD,
  OFFICE_WATCH_START_METHOD,
  OFFICE_WATCH_STOP_METHOD,
  type OfficeRpcMethod
} from '../../../../shared/office-preview-rpc'
import { executeOfficeMethod } from '../../../office/office-method-executor'
import { defineMethod, type RpcMethod } from '../core'

// Refined through the shared predicates rather than restating their rules: zod alone accepted a
// whitespace-only or NUL-carrying string that `isValidOfficeDocumentPath` rejects, and an invalid
// optional `workspaceRoot` then read as absent — silently probing this host's default lane instead
// of failing the call.
const WorkspaceRoot = z
  .string()
  .max(4096)
  .refine(isValidOfficeDocumentPath, { message: 'workspaceRoot is not a usable path' })
/**
 * Never absolute: the host joins this onto the workspace root and refuses anything that
 * canonicalises outside it, matching every neighbouring `files.*` method.
 */
const RelativePath = z.string().max(2048).refine(isValidOfficeRelativePath, {
  message: 'relativePath must be a non-empty path relative to the workspace root'
})
const WorkspaceDocument = { workspaceRoot: WorkspaceRoot, relativePath: RelativePath }
const SkillId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i)

const OptionalDocumentParams = z.object({ workspaceRoot: WorkspaceRoot.optional() }).strict()
const ProbeParams = z
  .object({ workspaceRoot: WorkspaceRoot.optional(), refresh: z.boolean().optional() })
  .strict()
const RequiredDocumentParams = z.object(WorkspaceDocument).strict()
const ElementParams = z
  .object({ ...WorkspaceDocument, elementPath: z.string().min(1).max(1024).startsWith('/') })
  .strict()
const SkillInstallParams = z
  .object({
    pairs: z
      .array(z.object({ skill: SkillId, agent: SkillId }).strict())
      .min(1)
      .max(200),
    workspaceRoot: WorkspaceRoot.optional()
  })
  .strict()

function officeMethod<TSchema extends z.ZodTypeAny>(
  name: OfficeRpcMethod,
  params: TSchema
): RpcMethod {
  return defineMethod({
    name,
    params,
    handler: (parsed) => executeOfficeMethod(name, parsed)
  })
}

export function createOfficeMethods(): RpcMethod[] {
  return [
    officeMethod(OFFICE_PROBE_METHOD, ProbeParams),
    officeMethod(OFFICE_SKILLS_LIST_METHOD, OptionalDocumentParams),
    officeMethod(OFFICE_SKILLS_INSTALL_METHOD, SkillInstallParams),
    officeMethod(OFFICE_RENDER_METHOD, RequiredDocumentParams),
    officeMethod(OFFICE_WATCH_START_METHOD, RequiredDocumentParams),
    officeMethod(OFFICE_WATCH_REFRESH_METHOD, RequiredDocumentParams),
    officeMethod(OFFICE_WATCH_STOP_METHOD, RequiredDocumentParams),
    officeMethod(OFFICE_SELECTION_METHOD, RequiredDocumentParams),
    officeMethod(OFFICE_MARKS_METHOD, RequiredDocumentParams),
    officeMethod(OFFICE_CLEAR_MARKS_METHOD, RequiredDocumentParams),
    officeMethod(OFFICE_GOTO_METHOD, ElementParams)
  ]
}
