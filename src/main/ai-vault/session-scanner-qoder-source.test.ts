/**
 * @author xiaopeng.fxp
 * @date 2026-09-30
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import { AI_VAULT_AGENTS, AI_VAULT_AGENT_LABELS } from '../../shared/ai-vault-types'
import { SUBAGENT_DIR_NAME } from './session-scanner-subagent-transcripts'

describe('Qoder AI Vault source registration', () => {
  it('registers qoder in agent types and human-readable labels', () => {
    const qoderIncluded = AI_VAULT_AGENTS.includes('qoder')
    expect(qoderIncluded).toBe(true)
    expect(AI_VAULT_AGENT_LABELS.qoder).toBe('Qoder')
  })

  it('declares ~/.qoder/projects root, jsonl extension, and excludes subagents directory', () => {
    const qoderSource = AI_VAULT_AGENT_SOURCES.qoder
    expect(qoderSource).toBeDefined()
    if (!qoderSource) {
      return
    }

    const defaultProjectDir = join(homedir(), '.qoder', 'projects')
    const declaredRoots = qoderSource.rootDirs({}, [])
    expect(declaredRoots).toEqual([defaultProjectDir])
    expect(qoderSource.extensions).toEqual(['.jsonl'])

    const isSubagentAllowed = qoderSource.directoryPredicate
      ? qoderSource.directoryPredicate(SUBAGENT_DIR_NAME, 1)
      : true
    expect(isSubagentAllowed).toBe(false)

    const isNormalDirAllowed = qoderSource.directoryPredicate
      ? qoderSource.directoryPredicate('workspace-123', 0)
      : true
    expect(isNormalDirAllowed).toBe(true)
  })
})
