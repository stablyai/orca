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
  OFFICE_WATCH_STOP_METHOD
} from '../../../../shared/office-preview-rpc'
import {
  OfficeDocumentParams,
  OfficeElementParams,
  OfficeOptionalDocumentParams,
  OfficeProbeParams,
  OfficeSkillInstallParams
} from '../../../../shared/rpc-contract/office-params'
import { executeOfficeMethod } from '../../../office/office-method-executor'
import { defineMethod } from '../core'

export const OFFICE_METHODS = [
  defineMethod({
    name: OFFICE_PROBE_METHOD,
    params: OfficeProbeParams,
    handler: async (params) => executeOfficeMethod(OFFICE_PROBE_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_SKILLS_LIST_METHOD,
    params: OfficeOptionalDocumentParams,
    handler: async (params) => executeOfficeMethod(OFFICE_SKILLS_LIST_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_SKILLS_INSTALL_METHOD,
    params: OfficeSkillInstallParams,
    handler: async (params) => executeOfficeMethod(OFFICE_SKILLS_INSTALL_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_RENDER_METHOD,
    params: OfficeDocumentParams,
    handler: async (params) => executeOfficeMethod(OFFICE_RENDER_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_WATCH_START_METHOD,
    params: OfficeDocumentParams,
    handler: async (params) => executeOfficeMethod(OFFICE_WATCH_START_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_WATCH_REFRESH_METHOD,
    params: OfficeDocumentParams,
    handler: async (params) => executeOfficeMethod(OFFICE_WATCH_REFRESH_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_WATCH_STOP_METHOD,
    params: OfficeDocumentParams,
    handler: async (params) => executeOfficeMethod(OFFICE_WATCH_STOP_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_SELECTION_METHOD,
    params: OfficeDocumentParams,
    handler: async (params) => executeOfficeMethod(OFFICE_SELECTION_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_MARKS_METHOD,
    params: OfficeDocumentParams,
    handler: async (params) => executeOfficeMethod(OFFICE_MARKS_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_CLEAR_MARKS_METHOD,
    params: OfficeDocumentParams,
    handler: async (params) => executeOfficeMethod(OFFICE_CLEAR_MARKS_METHOD, params)
  }),
  defineMethod({
    name: OFFICE_GOTO_METHOD,
    params: OfficeElementParams,
    handler: async (params) => executeOfficeMethod(OFFICE_GOTO_METHOD, params)
  })
]
