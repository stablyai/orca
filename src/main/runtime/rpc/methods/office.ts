/**
 * Office preview on a paired runtime host.
 *
 * Unlike the SSH relay — bundle-hash-locked to its client — a paired host and its client update
 * independently, so this surface is negotiated through `office.preview.v1`, which the host
 * advertises in `RUNTIME_CAPABILITIES`. The gate lives on the calling client, not here: what a
 * client has to survive is an OLDER host, which has no methods to gate with. It reads the
 * advertised capability up front and maps a `method_not_found` from one that slipped through to
 * "update the paired machine" — never to a preview that silently does nothing.
 *
 * The host-side work is `executeOfficeMethod`, identical to the local and SSH implementations:
 * `officecli` runs on the machine that owns the document, with that machine's fonts and locale.
 */
import { z } from 'zod'
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

const DocumentPath = z.string().min(1).max(4096)
const SkillId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i)

const OptionalDocumentParams = z.object({ path: DocumentPath.optional() }).strict()
const ProbeParams = z
  .object({ path: DocumentPath.optional(), refresh: z.boolean().optional() })
  .strict()
const RequiredDocumentParams = z.object({ path: DocumentPath }).strict()
const ElementParams = z
  .object({ path: DocumentPath, elementPath: z.string().min(1).max(1024).startsWith('/') })
  .strict()
const SkillInstallParams = z
  .object({
    pairs: z
      .array(z.object({ skill: SkillId, agent: SkillId }).strict())
      .min(1)
      .max(200),
    path: DocumentPath.optional()
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
