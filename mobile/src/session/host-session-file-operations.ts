import type { MobileFileTabDoc, MobileFileTabDocRequest } from '../files/mobile-file-tab-doc'

export type HostSessionFileOperations = {
  readTab(request: MobileFileTabDocRequest): Promise<MobileFileTabDoc>
}
