# SOL-TASKV1-007: Workflow sharing not implemented — see SOL-WF-01 + SOL-WF-03

**Resolves:** [BUG-TASKV1-007](../BUG-TASKV1-007-workflow-sharing-not-implemented.md)
**Full solution:** [SOL-WF-01-template-authoring-fields](../../logic-v1/solutions/SOL-WF-01-template-authoring-fields.md) + [SOL-WF-03-workflow-sharing-library](../../logic-v1/solutions/SOL-WF-03-workflow-sharing-library.md)
**Status:** 📋 Proposed — not yet implemented

Giải pháp đầy đủ đã được thiết kế tại 2 solution gốc ở trên — KHÔNG lặp lại
nội dung ở đây. Bug này (task-v1 framing) chỉ là xác nhận lại từ góc nhìn
"3 hệ Task" rằng cả hai solution gốc vẫn là hướng fix đúng, chưa implement
(re-verified: `Scope`'s 3-value `company|team|personal` enum at
`template.go:10-21` confirmed unchanged, no `visibility`/`owner_id`/
`share_token`/`rating`/`usage_count` column anywhere on `workflow.templates`).

Cả BUG-TASKV1-007 và BUG-WF-01/BUG-WF-03 gốc đều xác nhận cùng một root
cause: `workflow.templates`'s schema was narrowed at scaffold time and
never grew visibility/sharing/authoring columns — nên bug này cần cả hai
solution, không phải một.

## Tóm tắt điểm chính

SOL-WF-01 (migration `0007_...`) adds `owner_id`/`description`/`tags` and a
Clone-mode creation path, plus field-level `overrides`/`inject_steps`/
`remove_steps` deep-merge to replace the current all-or-nothing
inheritance swap. SOL-WF-03 (migration `0008_...`, must land **after**
0007 per its own explicit ordering note) builds on those columns to add
`visibility`/`share_token`/`rating_sum`/`rating_count`, the private→team→
company→public state machine with admin approval, share-link generation +
token-based anonymous preview + one-click import, and library text/tag
search with usage-count tracking.

## Điều chỉnh/bổ sung cần lưu ý

Implementation order matters and is already stated in SOL-WF-03 itself:
SOL-WF-01's `0007_template_authoring_fields` migration must land before
SOL-WF-03's `0008_template_visibility_sharing` migration, since the latter
only adds the columns the former has no reason to touch.
