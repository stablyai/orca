import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  repairTranslatedValue,
  repairCatalog,
  setLeaf,
  collectStringLeaves
} from './locale-translation-policy.mjs'

const enCatalog = JSON.parse(
  fs.readFileSync(new URL('../../src/renderer/src/i18n/locales/en.json', import.meta.url), 'utf8')
)
const koCatalog = JSON.parse(
  fs.readFileSync(new URL('../../src/renderer/src/i18n/locales/ko.json', import.meta.url), 'utf8')
)
const enValues = new Map(collectStringLeaves(enCatalog).map(({ key, value }) => [key, value]))

const workspaceTermCorrections = [
  {
    key: 'auto.components.TaskPage.linearEmptyUnfilteredScope',
    before: '이 워크트리 범위에 이슈가 없습니다. 검색하거나 팀을 조정해 보세요.',
    expected: '이 워크스페이스 범위에 이슈가 없습니다. 검색하거나 팀을 조정해 보세요.'
  },
  {
    key: 'auto.components.floating.terminal.FloatingTerminalToggleButton.4cb418b991',
    before: '플로팅 워크트리 표시, 새 활동',
    expected: '플로팅 워크스페이스 표시, 새 활동'
  },
  {
    key: 'auto.components.linear-issue-attribute-filter-dropdowns.allWorkspacesBody',
    before:
      '상태, 담당자, 레이블 필터는 단일 Linear �크트리의 ID를 사용합니다. 필터링할 워크트리를 선택하세요.',
    expected:
      '상태, 담당자, 레이블 필터는 단일 Linear 워크스페이스의 ID를 사용합니다. 해당 속성으로 필터링할 워크스페이스 하나를 선택하세요.'
  },
  {
    key: 'auto.components.linear-issue-attribute-filter-dropdowns.allWorkspacesTitle',
    before: '워크트리 선택',
    expected: '워크스페이스 선택'
  },
  {
    key: 'auto.components.linear-issue-attribute-filter-dropdowns.teamRequired',
    before: '이 워크트리의 상태, 담당자, 레이블을 로드하려면 팀을 선택하세요.',
    expected: '이 워크스페이스의 상태, 담당자, 레이블을 로드하려면 팀을 선택하세요.'
  },
  {
    key: 'auto.components.right.sidebar.source.control.ai.push.failure.launch.216f762bd7',
    before: '워크트리 연결을 확인할 수 없습니다.',
    expected: '워크스페이스 연결을 확인할 수 없습니다.'
  },
  {
    key: 'auto.components.right.sidebar.source.control.ai.recovery.launch.216f762bd7',
    before: '워크트리 연결을 확인할 수 없습니다.',
    expected: '워크스페이스 연결을 확인할 수 없습니다.'
  },
  {
    key: 'auto.components.settings.LinearAgentSkillGuide.noteLinkedBody',
    before:
      '작업에서 만든 워크스페이스는 이슈가 컨텍스트로 연결되어 있어 이슈 작업이 가장 원활합니다.',
    expected:
      '작업에서 만든 워크트리는 이슈가 컨텍스트로 연결되어 있어 이슈 작업이 가장 원활합니다.'
  },
  {
    key: 'auto.components.settings.LinearAgentSkillPane.howToUseDescription',
    before:
      '카드를 클릭해 프롬프트를 복사하세요. 스킬을 설치한 후 Linear에 연결된 워크스페이스에서 사용하세요.',
    expected:
      '카드를 클릭해 프롬프트를 복사하세요. 스킬을 설치한 후 Linear에 연결된 워크트리에서 사용하세요.'
  },
  {
    key: 'auto.components.shared.useDaemonActions.a702d4196e',
    before:
      '이 작업은 모든 워크트리의 모든 터미널 탭을 닫고 현재 터미널 세션의 종료를 요청합니다. 저장되지 않은 터미널 작업은 손실됩니다. 데몬 자체는 계속 실행되며 새 터미널은 즉시 열 수 있습니다. 이 작업은 되돌릴 수 없습니다.',
    expected:
      '이 작업은 모든 워크스페이스의 모든 터미널 탭을 닫고 현재 터미널 세션의 종료를 요청합니다. 저장되지 않은 터미널 작업은 손실됩니다. 데몬 자체는 계속 실행되며 새 터미널은 즉시 열 수 있습니다. 이 작업은 되돌릴 수 없습니다.'
  },
  {
    key: 'auto.components.sidebar.ForgetSshWorkspaceDialog.disconnectedBody',
    before:
      '이 워크트리의 SSH 호스트가 연결되어 있지 않습니다. 재연결하여 원격에서도 삭제하거나 Orca에서만 제거하세요.',
    expected:
      '이 워크스페이스의 SSH 호스트가 연결되어 있지 않습니다. 재연결하여 원격에서도 삭제하거나 Orca에서만 제거하세요.'
  },
  {
    key: 'auto.components.sidebar.HostRemoveDialog.manyWorkspaces',
    before: '워크트리 {{count}}개',
    expected: '워크스페이스 {{count}}개'
  },
  {
    key: 'auto.components.sidebar.HostRemoveDialog.oneWorkspace',
    before: '워크트리 1개',
    expected: '워크스페이스 1개'
  },
  {
    key: 'auto.components.sidebar.HostRemoveDialog.workspacesFailed',
    before:
      '이 호스트에서 워크트리 {{count}}개를 제거할 수 없었습니다. 재시도할 수 있도록 호스트가 유지되었습니다.',
    expected:
      '이 호스트에서 워크스페이스 {{count}}개를 제거할 수 없었습니다. 재시도할 수 있도록 호스트가 유지되었습니다.'
  },
  {
    key: 'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09',
    before: '상위 워크스페이스 열기',
    expected: '상위 워크트리 열기'
  },
  {
    key: 'auto.components.sidebar.WorktreeList.failedUnnestWorkspace',
    before: '워크트리 펼치기 실패',
    expected: '워크스페이스 펼치기 실패'
  },
  {
    key: 'auto.components.sidebar.delete.worktree.toast.locked',
    before:
      '이 워크트리는 Git에 의해 잠겨 있습니다. 저장소에서 git worktree unlock <worktree-path>을 실행한 후 삭제를 다시 시도하세요.',
    expected:
      '이 워크스페이스는 Git에 의해 잠겨 있습니다. 저장소에서 git worktree unlock <worktree-path>을 실행한 후 삭제를 다시 시도하세요.'
  },
  {
    key: 'auto.components.sidebar.delete.worktree.toast.lockedReason',
    before:
      '이 워크트리는 Git에 의해 잠겨 있습니다. Git 보고: {{value0}}. 저장소에서 git worktree unlock <worktree-path>을 실행한 후 삭제를 다시 시도하세요.',
    expected:
      '이 워크스페이스는 Git에 의해 잠겨 있습니다. Git 보고: {{value0}}. 저장소에서 git worktree unlock <worktree-path>을 실행한 후 삭제를 다시 시도하세요.'
  },
  {
    key: 'auto.components.tab.group.AiVaultSessionDropLayer.openSupportedWorkspace',
    before: '세션을 재개하기 전에 워크트리를 여세요.',
    expected: '세션을 재개하기 전에 워크스페이스를 여세요.'
  },
  {
    key: 'auto.components.terminal.pane.TerminalSshReconnectOverlay.removeWorkspaceButton',
    before: '워크트리 제거',
    expected: '워크스페이스 제거'
  },
  {
    key: 'auto.components.terminal.pane.TerminalSshReconnectOverlay.removedBody',
    before:
      '이 워크트리의 SSH 호스트가 제거되어 더 이상 연결할 수 없습니다. 워크트리를 제거하여 정리하세요 — 원격 파일은 그대로 남아 있습니다.',
    expected:
      '이 워크스페이스의 SSH 호스트가 제거되어 더 이상 연결할 수 없습니다. 워크스페이스를 제거하여 정리하세요 — 원격 파일은 그대로 남아 있습니다.'
  },
  {
    key: 'auto.lib.sidebarWorktreeActivation.wakeEphemeralVmFailed',
    before: '임시 VM 워크트리 활성화 실패',
    expected: '임시 VM 워크스페이스 활성화 실패'
  }
]

function placeholders(value) {
  return (value.match(/{{[^{}]+}}/g) ?? []).sort()
}

describe('locale-ko-key-overrides', () => {
  it('keeps Korean key override data scoped to Korean values', () => {
    const overrides = JSON.parse(
      fs.readFileSync(new URL('./locale-ko-key-overrides.json', import.meta.url), 'utf8')
    )
    for (const value of Object.values(overrides)) {
      expect(Object.keys(value)).toEqual(['ko'])
    }
  })

  it('repairs the 22 Korean workspace/worktree object mismatches', () => {
    for (const { key, before, expected } of workspaceTermCorrections) {
      const enValue = enValues.get(key)
      expect(enValue, key).toBeTypeOf('string')
      expect(repairTranslatedValue({ key, enValue, localeValue: before, locale: 'ko' }), key).toBe(
        expected
      )
    }
  })

  it('keeps corrected Korean workspace/worktree values stable', () => {
    for (const { key, expected } of workspaceTermCorrections) {
      const enValue = enValues.get(key)
      const first = repairTranslatedValue({ key, enValue, localeValue: expected, locale: 'ko' })
      expect(first, key).toBe(expected)
      expect(repairTranslatedValue({ key, enValue, localeValue: first, locale: 'ko' }), key).toBe(
        expected
      )
      expect(repairTranslatedValue({ key, enValue, localeValue: enValue, locale: 'ko' }), key).toBe(
        expected
      )
    }
  })

  it('preserves all 22 terms through catalog repair', () => {
    const catalog = structuredClone(koCatalog)
    for (const { key, before } of workspaceTermCorrections) {
      setLeaf(catalog, key, before)
    }
    for (let pass = 0; pass < 2; pass += 1) {
      repairCatalog(enCatalog, catalog, 'ko')
      const repaired = new Map(collectStringLeaves(catalog).map(({ key, value }) => [key, value]))
      for (const { key, expected } of workspaceTermCorrections) {
        expect(repaired.get(key), key).toBe(expected)
      }
    }

    const shippedCatalog = structuredClone(koCatalog)
    repairCatalog(enCatalog, shippedCatalog, 'ko')
    const shipped = new Map(
      collectStringLeaves(shippedCatalog).map(({ key, value }) => [key, value])
    )
    for (const { key, expected } of workspaceTermCorrections) {
      expect(shipped.get(key), key).toBe(expected)
    }
  })

  it('preserves placeholders and Git unlock command literals', () => {
    for (const { key, before, expected } of workspaceTermCorrections) {
      const enValue = enValues.get(key)
      const repaired = repairTranslatedValue({ key, enValue, localeValue: before, locale: 'ko' })
      const tokens = placeholders(enValue)
      for (const value of [before, expected, repaired]) {
        expect(placeholders(value), key).toEqual(tokens)
      }

      if (key.startsWith('auto.components.sidebar.delete.worktree.toast.locked')) {
        for (const value of [enValue, before, expected, repaired]) {
          expect(value, key).toContain('git worktree unlock <worktree-path>')
          if (key.endsWith('lockedReason')) {
            expect(value, key).toContain('{{value0}}')
          }
        }
      }
      if (key === 'auto.components.linear-issue-attribute-filter-dropdowns.allWorkspacesBody') {
        expect(expected, key).not.toContain('\uFFFD')
        expect(repaired, key).not.toContain('\uFFFD')
      }
    }
  })
})
