import type {
  NpmPackageInfoRequest,
  NpmPackageInfoResult
} from '../../shared/npm-package-info-types'

export type NpmPackageInfoApi = {
  npmPackageInfo: {
    lookup: (request: NpmPackageInfoRequest) => Promise<NpmPackageInfoResult>
  }
}
