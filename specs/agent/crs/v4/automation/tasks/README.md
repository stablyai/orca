# agent Tasks — Automations (v4)

**Solutions:** [../solutions/](../solutions/README.md)

| Task | Solution | Depends on | Status |
|---|---|---|---|
| [TASK-AG-AUTO-001](./TASK-AG-AUTO-001-verify-shell-notification-contract.md) — integration test `shell.exec`/`notification.send` | SOL-AG-AUTO-001 | Không | ✅ DONE |

Chỉ 1 task cho toàn nhóm CR-AUTO-001..008 — xem
[solutions/README.md](../solutions/README.md)'s đánh giá trạng thái:
agent RPC surface (`git.commit`/`git.push`/`shell.exec`/
`notification.send`) đã đủ dùng, không cần handler mới nào.

## Nguyên tắc chung cho AI thực thi task này

- **Luôn chạy `impact()`/`codegraph explore` trước khi sửa symbol** —
  dù task này chủ yếu thêm test, không sửa handler, vẫn cần xác nhận
  `shell.exec`/`notification.send`'s call site không đổi trong lúc viết
  test.
- **Không suy đoán response shape** — đọc `agent-rpc-dispatch-misc.ts`,
  `notification-send-handler.ts` thật trước khi viết assertion.
- **Test trước, không giả định pass.**
