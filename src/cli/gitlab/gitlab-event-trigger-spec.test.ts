import { describe, expect, it } from 'vitest'
import {
  formatAutomationEventTrigger,
  parseAutomationEventTrigger
} from '../automations/automation-event-trigger-spec'

describe('--on gitlab.<event>', () => {
  it('reads a GitLab event as a webhook rule on the GitLab event header', () => {
    expect(
      parseAutomationEventTrigger(
        'gitlab.comment in=acme/web,acme/api from=@dana contains="@scout"'
      )
    ).toEqual({
      id: '',
      source: 'webhook',
      event: 'call',
      rev: 0,
      where: [
        { path: 'headers.x-gitlab-event', op: '=', values: ['Note Hook'] },
        { path: 'body.project.path_with_namespace', op: 'in', values: ['acme/api', 'acme/web'] },
        {
          path: 'body.object_attributes.noteable_type',
          op: 'in',
          values: ['Issue', 'MergeRequest']
        },
        { path: 'body.user.username', op: 'in', values: ['dana'] },
        { path: 'body.object_attributes.note', op: 'contains', values: ['@scout'] }
      ],
      pick: [
        'body.object_attributes.note',
        'body.object_attributes.url',
        'body.object_attributes.noteable_type',
        'body.issue.iid',
        'body.merge_request.iid',
        'body.user.username',
        'body.project.path_with_namespace'
      ],
      subjectFrom: 'body.object_attributes.discussion_id'
    })
  })

  it('formats a saved GitLab rule back as the GitLab event, and an edited one as a plain webhook', () => {
    const trigger = parseAutomationEventTrigger(
      'gitlab.pipeline_failed in=acme/web host=gitlab.acme.dev'
    )
    expect(formatAutomationEventTrigger(trigger)).toBe(
      'gitlab.pipeline_failed in=acme/web host=gitlab.acme.dev'
    )

    const edited = {
      ...trigger,
      where: [...(trigger.source === 'webhook' ? (trigger.where ?? []) : [])].slice(0, 2)
    }
    expect(formatAutomationEventTrigger(edited)).toMatch(/^webhook\.call /)
  })

  it('refuses a rule GitLab could not be set up for', () => {
    expect(() => parseAutomationEventTrigger('gitlab.comment contains=@scout')).toThrow(/needs in=/)
    expect(() => parseAutomationEventTrigger('gitlab.mr_opened in=acme/web contains=x')).toThrow(
      /contains= is for gitlab.comment only/
    )
    expect(() => parseAutomationEventTrigger('gitlab.pushed in=acme/web')).toThrow(/Unknown event/)
    expect(() => parseAutomationEventTrigger('gitlab.comment in=acme/web from=@')).toThrow(
      /needs from= to name GitLab usernames/
    )
  })
})
