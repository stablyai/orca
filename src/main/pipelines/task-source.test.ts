import { describe, expect, it } from 'vitest'
import { resolvePipelineTaskSource } from './task-source'

describe('resolvePipelineTaskSource', () => {
  it('returns manual tasks without executing shell commands', async () => {
    const result = await resolvePipelineTaskSource({
      taskSource: {
        type: 'manual',
        tasks: [
          { id: 'manual-1', title: 'First task', body: 'Implement first thing' },
          { id: 'manual-2', title: 'Second task', body: 'Implement second thing' }
        ]
      },
      commandRunner: async () => {
        throw new Error('manual source must not execute commands')
      }
    })

    expect(result.tasks).toEqual([
      {
        sourceType: 'manual',
        sourceId: 'manual-1',
        title: 'First task',
        body: 'Implement first thing',
        url: null,
        labels: []
      },
      {
        sourceType: 'manual',
        sourceId: 'manual-2',
        title: 'Second task',
        body: 'Implement second thing',
        url: null,
        labels: []
      }
    ])
    expect(result.listTasksCommand).toBe('pipeline:manual:list')
    expect(result.viewTaskCommand('manual-1')).toBe('pipeline:manual:view manual-1')
    expect(result.closeTaskCommand('manual-1')).toBe('pipeline:manual:close manual-1')
  })

  it('lists the full open ready task set for the derived Pipeline PRD label', async () => {
    const calls: string[] = []
    const result = await resolvePipelineTaskSource({
      taskSource: {
        type: 'github_issues',
        provider: 'github',
        owner: 'Nikolatesla-lj',
        repo: 'orca',
        prdIssueNumber: 13,
        pipelinePrdLabel: 'pipeline:prd-13',
        state: 'open'
      },
      commandRunner: async ({ command }) => {
        calls.push(command)
        if (command.startsWith('gh issue view 13')) {
          return JSON.stringify({
            number: 13,
            title: 'Pipeline PRD',
            state: 'OPEN',
            url: 'https://github.com/Nikolatesla-lj/orca/issues/13'
          })
        }
        return JSON.stringify([
          {
            number: 16,
            title: 'Implement task source',
            body: '## Parent\n\n- PRD issue: #13',
            state: 'OPEN',
            url: 'https://github.com/Nikolatesla-lj/orca/issues/16',
            labels: [
              { name: 'ready-for-agent' },
              { name: 'task-slice' },
              { name: 'pipeline:prd-13' }
            ]
          },
          {
            number: 17,
            title: 'Wrong PRD',
            body: '## Parent\n\n- PRD issue: #2',
            state: 'OPEN',
            url: 'https://github.com/Nikolatesla-lj/orca/issues/17',
            labels: [
              { name: 'ready-for-agent' },
              { name: 'task-slice' },
              { name: 'pipeline:prd-13' }
            ]
          }
        ])
      }
    })

    expect(calls).toEqual([
      'gh issue view 13 --repo Nikolatesla-lj/orca --json number,title,state,url',
      'gh issue list --repo Nikolatesla-lj/orca --state open --limit 100 --label task-slice --label ready-for-agent --label pipeline:prd-13 --json number,title,body,state,url,labels'
    ])
    expect(result.tasks).toEqual([
      {
        sourceType: 'github_issue',
        sourceId: '16',
        title: 'Implement task source',
        body: '## Parent\n\n- PRD issue: #13',
        url: 'https://github.com/Nikolatesla-lj/orca/issues/16',
        labels: ['ready-for-agent', 'task-slice', 'pipeline:prd-13']
      }
    ])
    expect(result.viewTaskCommand('16')).toBe(
      'gh issue view 16 --repo Nikolatesla-lj/orca --comments'
    )
    expect(result.closeTaskCommand('16')).toBe('gh issue close 16 --repo Nikolatesla-lj/orca')
  })

  it('rejects closed PRDs and non-derived Pipeline PRD labels', async () => {
    await expect(
      resolvePipelineTaskSource({
        taskSource: {
          type: 'github_issues',
          provider: 'github',
          owner: 'Nikolatesla-lj',
          repo: 'orca',
          prdIssueNumber: 13,
          pipelinePrdLabel: 'pipeline:prd-2',
          state: 'open'
        },
        commandRunner: async () => '[]'
      })
    ).rejects.toThrow(/pipeline:prd-13/)

    await expect(
      resolvePipelineTaskSource({
        taskSource: {
          type: 'github_issues',
          provider: 'github',
          owner: 'Nikolatesla-lj',
          repo: 'orca',
          prdIssueNumber: 13,
          pipelinePrdLabel: 'pipeline:prd-13',
          state: 'open'
        },
        commandRunner: async ({ command }) =>
          command.startsWith('gh issue view 13')
            ? JSON.stringify({ number: 13, title: 'PRD', state: 'CLOSED' })
            : '[]'
      })
    ).rejects.toThrow(/must be open/)
  })
})
