import type {
  OrcaBackgroundImageLoadResult,
  OrcaBackgroundImportResult,
  OrcaBackgroundLibrary,
  OrcaBackgroundOpenLibraryResult
} from '../../shared/orca-background-library-types'

export type OrcaBackgroundApi = {
  listLibrary: () => Promise<OrcaBackgroundLibrary>
  addImages: () => Promise<OrcaBackgroundImportResult>
  openLibrary: () => Promise<OrcaBackgroundOpenLibraryResult>
  loadImage: (fileName: string) => Promise<OrcaBackgroundImageLoadResult>
}

export type {
  OrcaBackgroundImageLoadResult,
  OrcaBackgroundImportResult,
  OrcaBackgroundLibrary,
  OrcaBackgroundLibraryImage,
  OrcaBackgroundOpenLibraryResult
} from '../../shared/orca-background-library-types'
