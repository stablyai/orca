import { ipcRenderer } from 'electron'
import {
  NPM_PACKAGE_INFO_LOOKUP_CHANNEL,
  type NpmPackageInfoRequest,
  type NpmPackageInfoResult
} from '../../shared/npm-package-info-types'

export const npmPackageInfoApi = {
  lookup: (request: NpmPackageInfoRequest): Promise<NpmPackageInfoResult> =>
    ipcRenderer.invoke(NPM_PACKAGE_INFO_LOOKUP_CHANNEL, request)
}
