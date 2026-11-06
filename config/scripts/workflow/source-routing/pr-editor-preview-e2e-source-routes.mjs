import { isUnitTestSupportSource } from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

export const PR_EDITOR_PREVIEW_E2E_SOURCE_ROUTES = [
  {
    // Image, PDF and media viewers read orca-media grants; the PDF reloads exercise remint and range reads.
    id: 'editor.byte-range-preview',
    specs: [
      'tests/e2e/editor-media-playback-position.spec.ts',
      'tests/e2e/media-preview-partition-isolation.spec.ts',
      'tests/e2e/paired-remote-large-file-open.spec.ts',
      'tests/e2e/pdf-find-counter.spec.ts',
      'tests/e2e/pdf-viewer-rebuild-recovery.spec.ts',
      'tests/e2e/pdf-viewer-reload-cleanup.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      (/^src\/main\/media\/[^/]+\.ts$/.test(file) ||
        /^src\/renderer\/src\/components\/editor\/(?:ImageViewer|PdfViewer|pdf-document-loader|pdf-js-document-options|pdf-orca-media-range-transport)\.tsx?$/.test(
          file
        ) ||
        /^src\/renderer\/src\/components\/editor\/(?:EditorEditFileSurface|EditorConflictReviewSurface)\.tsx$/.test(
          file
        ) ||
        [
          'src/main/ipc/filesystem/filesystem-read-handlers.ts',
          'src/main/startup/privileged-custom-schemes.ts',
          'src/preload/api/fs-bridge.ts',
          'src/renderer/src/runtime/runtime-file-range-preview.ts',
          'src/renderer/src/runtime/runtime-file-read-client.ts',
          'src/shared/file-preview-kind.ts'
        ].includes(file))
  }
]
