import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { main as verifyMobileCatalog } from './verify-mobile-localization-catalog.mjs'

const LOCALES = ['en', 'es', 'ja', 'ko', 'zh']
const NATIVE_LOCALES = ['en', 'es', 'ja', 'ko', 'zh-Hans']
const NATIVE_CATALOG = {
  ios: {
    CFBundleDisplayName: 'Orca',
    NSCameraUsageDescription: 'Camera fallback',
    NSLocalNetworkUsageDescription: 'Network fallback',
    NSMicrophoneUsageDescription: 'Microphone fallback',
    NSPhotoLibraryUsageDescription: 'Photo fallback'
  },
  android: { app_name: 'Orca' }
}

function localizedNativeCatalog(locale) {
  if (locale === 'en') {
    return NATIVE_CATALOG
  }
  return {
    ios: Object.fromEntries(
      Object.entries(NATIVE_CATALOG.ios).map(([key, value]) => [
        key,
        value === 'Orca' ? value : `${locale} ${value}`
      ])
    ),
    android: NATIVE_CATALOG.android
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function makeProject(catalogs) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-reviewed-terminology-'))
  const appDirectory = path.join(root, 'mobile', 'app')
  const localeDirectory = path.join(root, 'mobile', 'src', 'i18n', 'locales')
  const nativeLocaleDirectory = path.join(root, 'mobile', 'locales')
  mkdirSync(appDirectory, { recursive: true })
  mkdirSync(localeDirectory, { recursive: true })
  mkdirSync(nativeLocaleDirectory, { recursive: true })
  writeFileSync(
    path.join(appDirectory, 'Example.tsx'),
    `
import { t } from '@/i18n/mobile-i18n'
export const labels = [
  t('task.rerunFailed'),
  t('task.mergeRequests'),
  t('task.mergePullRequestTitle'),
  t('task.mergeMerge'),
  t('task.noPipeline'),
  t('task.pipeline'),
  t('task.failedUpdateGitHubIssue'),
  t('terminalAccessoryKeyCatalog.interrupt'),
  t('terminalAccessoryKeyCatalog.escape'),
  t('customKeyModal.eGBuild'),
  t('authFailedBanner.re')
]
`,
    'utf8'
  )
  writeJson(path.join(root, 'mobile', 'app.json'), {
    expo: {
      name: 'Orca',
      locales: Object.fromEntries(
        NATIVE_LOCALES.map((locale) => [locale, `./locales/${locale}.json`])
      ),
      ios: {
        infoPlist: {
          NSLocalNetworkUsageDescription: 'Network fallback',
          NSMicrophoneUsageDescription: 'Microphone fallback',
          NSPhotoLibraryUsageDescription: 'Photo fallback'
        }
      },
      plugins: [
        ['expo-localization', { supportedLocales: NATIVE_LOCALES }],
        [
          'expo-camera',
          { cameraPermission: 'Camera fallback', microphonePermission: 'Microphone fallback' }
        ],
        ['expo-image-picker', { photosPermission: 'Photo fallback' }]
      ]
    }
  })
  for (const locale of LOCALES) {
    writeJson(path.join(localeDirectory, `${locale}.json`), catalogs[locale] ?? {})
  }
  for (const locale of NATIVE_LOCALES) {
    writeJson(path.join(nativeLocaleDirectory, `${locale}.json`), localizedNativeCatalog(locale))
  }
  return root
}

describe('reviewed mobile localization terminology', () => {
  it('protects mobile audit actions and provider terminology', async () => {
    const root = makeProject({
      en: {
        task: {
          rerunFailed: 'Rerun failed',
          mergeRequests: 'Merge requests and issues by repository',
          mergePullRequestTitle: 'Merge Pull Request',
          mergeMerge: 'Merge merge request',
          noPipeline: 'No pipeline runs for this MR.',
          pipeline: 'Pipeline',
          failedUpdateGitHubIssue: 'Failed to update GitHub issue'
        },
        terminalAccessoryKeyCatalog: { interrupt: 'Interrupt terminal', escape: 'Escape' },
        customKeyModal: { eGBuild: 'e.g. Build' },
        authFailedBanner: { re: 'Re-pair' }
      },
      es: {
        task: {
          rerunFailed: 'Error al volver a ejecutar',
          mergeRequests: 'Fusionar solicitudes y problemas por repositorio',
          mergePullRequestTitle: 'Solicitud de extracción de fusión',
          mergeMerge: 'Solicitud de fusión de fusión'
        },
        terminalAccessoryKeyCatalog: { interrupt: 'Terminal de interrupción', escape: 'Escapar' },
        authFailedBanner: { re: 'Reparar' }
      },
      ja: {
        task: { failedUpdateGitHubIssue: 'GitHub の更新に失敗する問題' },
        authFailedBanner: { re: '修理' }
      },
      ko: { customKeyModal: { eGBuild: '예를 들어 짓다' } },
      zh: {
        task: { noPipeline: '此 MR 没有运行任何管道。', pipeline: '管道' },
        authFailedBanner: { re: '维修' }
      }
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(verifyMobileCatalog(root)).resolves.toBe(1)
      const report = error.mock.calls.flat().join('\n')
      expect(report).toContain('es.json product terminology mismatch: task.rerunFailed')
      expect(report).toContain('es.json product terminology mismatch: task.mergeRequests')
      expect(report).toContain('es.json product terminology mismatch: task.mergePullRequestTitle')
      expect(report).toContain(
        'es.json product terminology mismatch: terminalAccessoryKeyCatalog.escape'
      )
      expect(report).toContain('ja.json product terminology mismatch: task.failedUpdateGitHubIssue')
      expect(report).toContain('ko.json product terminology mismatch: customKeyModal.eGBuild')
      expect(report).toContain('zh.json product terminology mismatch: task.pipeline')
      expect(report).toContain('zh.json product terminology mismatch: authFailedBanner.re')
    } finally {
      error.mockRestore()
    }
  })
})
