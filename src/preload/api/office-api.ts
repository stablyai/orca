import type {
  OfficeDocumentRequest,
  OfficeElementRequest,
  OfficeProbeRequest,
  OfficeSkillsInstallRequest,
  OfficeSkillsListRequest,
  OfficeSnapshotRequest,
  OfficeSnapshotResult
} from '../../shared/office-preview-channels'
import type {
  OfficeAckOutcome,
  OfficeMarksOutcome,
  OfficeProbeOutcome,
  OfficeSelectionOutcome,
  OfficeSkillCatalogOutcome,
  OfficeSkillInstallOutcome,
  OfficeWatchOutcome
} from '../../shared/office-preview-contracts'

export type OfficeApi = {
  office: {
    probe: (request: OfficeProbeRequest) => Promise<OfficeProbeOutcome>
    /** Renders on the owning host and answers a preview URL. The bytes stay in main. */
    openSnapshot: (request: OfficeSnapshotRequest) => Promise<OfficeSnapshotResult>
    releaseSnapshot: (grantId: string) => Promise<boolean>
    watchStart: (request: OfficeDocumentRequest) => Promise<OfficeWatchOutcome>
    watchRefresh: (request: OfficeDocumentRequest) => Promise<OfficeAckOutcome>
    watchStop: (request: OfficeDocumentRequest) => Promise<OfficeAckOutcome>
    selection: (request: OfficeDocumentRequest) => Promise<OfficeSelectionOutcome>
    marks: (request: OfficeDocumentRequest) => Promise<OfficeMarksOutcome>
    clearMarks: (request: OfficeDocumentRequest) => Promise<OfficeMarksOutcome>
    /** Scrolls every page connected to the watch process to one element. */
    goto: (request: OfficeElementRequest) => Promise<OfficeAckOutcome>
    skillsList: (request: OfficeSkillsListRequest) => Promise<OfficeSkillCatalogOutcome>
    skillsInstall: (request: OfficeSkillsInstallRequest) => Promise<OfficeSkillInstallOutcome>
  }
}
