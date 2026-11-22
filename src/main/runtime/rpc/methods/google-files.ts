// google.drive.*, google.docs.*, google.sheets.*: files as a Google account signed in on this host,
// for its owner or a bot whose Google is on. Tokens never leave the host.
import {
  makeFolder,
  moveDrive,
  searchDrive,
  shareDrive,
  uploadDrive
} from '../../../google/google-drive'
import { downloadDrive, readDrive } from '../../../google/google-drive-read'
import {
  appendDoc,
  commentOnDoc,
  createDoc,
  readDoc,
  replaceInDoc
} from '../../../google/google-docs'
import {
  appendSheet,
  createSheet,
  readSheet,
  upsertSheet,
  writeSheet
} from '../../../google/google-sheets'
import {
  DocsAppendParams,
  DocsCommentParams,
  DocsCreateParams,
  DocsReadParams,
  DocsReplaceParams,
  DriveDownloadParams,
  DriveListParams,
  DriveMkdirParams,
  DriveMoveParams,
  DriveReadParams,
  DriveSearchParams,
  DriveShareParams,
  DriveUploadParams,
  SheetsAppendParams,
  SheetsCreateParams,
  SheetsReadParams,
  SheetsUpsertParams,
  SheetsWriteParams
} from '../../../../shared/rpc-contract/google-files-params'
import { defineMethod } from '../core'
import { attributedGoogleText, googleApiForCaller, googleWriteAskedBy } from '../google-caller-api'

export const GOOGLE_FILES_METHODS = [
  defineMethod({
    name: 'google.drive.search',
    permission: 'workspace',
    params: DriveSearchParams,
    handler: async (params, context) =>
      searchDrive(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.drive.list',
    permission: 'workspace',
    params: DriveListParams,
    handler: async (params, context) =>
      searchDrive(await googleApiForCaller(params, context), { ...params, in: params.folder })
  }),
  defineMethod({
    name: 'google.drive.read',
    permission: 'workspace',
    params: DriveReadParams,
    handler: async (params, context) => readDrive(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.drive.download',
    permission: 'workspace',
    params: DriveDownloadParams,
    handler: async (params, context) =>
      downloadDrive(await googleApiForCaller(params, context), params.ref)
  }),
  defineMethod({
    name: 'google.drive.upload',
    permission: 'workspace',
    params: DriveUploadParams,
    handler: async (params, context) =>
      uploadDrive(await googleApiForCaller(params, context), {
        ...params,
        askedBy: await googleWriteAskedBy(params, context)
      })
  }),
  defineMethod({
    name: 'google.drive.mkdir',
    permission: 'workspace',
    params: DriveMkdirParams,
    handler: async (params, context) =>
      makeFolder(await googleApiForCaller(params, context), {
        ...params,
        askedBy: await googleWriteAskedBy(params, context)
      })
  }),
  defineMethod({
    name: 'google.drive.move',
    permission: 'workspace',
    params: DriveMoveParams,
    handler: async (params, context) => moveDrive(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.drive.share',
    permission: 'workspace',
    params: DriveShareParams,
    handler: async (params, context) =>
      shareDrive(await googleApiForCaller(params, context), {
        ...params,
        askedBy: await googleWriteAskedBy(params, context)
      })
  }),
  defineMethod({
    name: 'google.docs.read',
    permission: 'workspace',
    params: DocsReadParams,
    handler: async (params, context) => readDoc(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.docs.create',
    permission: 'workspace',
    params: DocsCreateParams,
    handler: async (params, context) =>
      createDoc(await googleApiForCaller(params, context), {
        ...params,
        askedBy: await googleWriteAskedBy(params, context)
      })
  }),
  defineMethod({
    name: 'google.docs.append',
    permission: 'workspace',
    params: DocsAppendParams,
    handler: async (params, context) => appendDoc(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.docs.replace',
    permission: 'workspace',
    params: DocsReplaceParams,
    handler: async (params, context) =>
      replaceInDoc(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.docs.comment',
    permission: 'workspace',
    params: DocsCommentParams,
    handler: async (params, context) =>
      commentOnDoc(await googleApiForCaller(params, context), {
        ...params,
        text: (await attributedGoogleText(params.text, params, context)) ?? params.text
      })
  }),
  defineMethod({
    name: 'google.sheets.create',
    permission: 'workspace',
    params: SheetsCreateParams,
    handler: async (params, context) =>
      createSheet(await googleApiForCaller(params, context), params.title)
  }),
  defineMethod({
    name: 'google.sheets.read',
    permission: 'workspace',
    params: SheetsReadParams,
    handler: async (params, context) => readSheet(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.sheets.write',
    permission: 'workspace',
    params: SheetsWriteParams,
    handler: async (params, context) =>
      writeSheet(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.sheets.append',
    permission: 'workspace',
    params: SheetsAppendParams,
    handler: async (params, context) =>
      appendSheet(await googleApiForCaller(params, context), params)
  }),
  defineMethod({
    name: 'google.sheets.upsert',
    permission: 'workspace',
    params: SheetsUpsertParams,
    handler: async (params, context) =>
      upsertSheet(await googleApiForCaller(params, context), params)
  })
] as const
