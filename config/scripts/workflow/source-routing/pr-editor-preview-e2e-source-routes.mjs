import { isUnitTestSupportSource } from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

export const PR_EDITOR_PREVIEW_E2E_SOURCE_ROUTES = [
  {
    // Rich Markdown Find owns focus handoff and selection preservation between its inputs and the editor.
    id: 'editor.rich-markdown-find',
    specs: [
      'tests/e2e/markdown-find-adversarial.spec.ts',
      'tests/e2e/markdown-find-editing.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) &&
      (file.startsWith('src/renderer/src/components/editor/rich-markdown/search/') ||
        file ===
          'src/renderer/src/components/editor/rich-markdown/instance/RichMarkdownEditorSurface.tsx')
  },
  {
    // Same-path files on two hosts must keep separate Monaco models, and each tab reads from its captured owner.
    id: 'editor.host-model-identity',
    specs: ['tests/e2e/editor-model-host-isolation.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      (file.startsWith('src/renderer/src/components/editor/model-lifetime/identity/') ||
        [
          'src/renderer/src/components/editor/useEditorPanelFileContentLoader.ts',
          'src/renderer/src/lib/editor/file-operations/editor-file-operation-owner.ts',
          'src/renderer/src/lib/editor/file-operations/editor-file-operation-provenance.ts'
        ].includes(file))
  },
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
          'src/renderer/src/runtime/files/reads/runtime-file-range-preview.ts',
          'src/renderer/src/runtime/files/reads/runtime-file-read-client.ts',
          'src/shared/file-preview/file-preview-kind.ts'
        ].includes(file))
  },
  {
    id: 'editor.csv-preview',
    specs: [
      'tests/e2e/csv-paged-preview.spec.ts',
      'tests/e2e/csv-table-editing.spec.ts',
      'tests/e2e/csv-url-links.spec.ts'
    ],
    matches: (file) =>
      isProductSource(file) && file.startsWith('src/renderer/src/components/editor/csv/')
  }
]
