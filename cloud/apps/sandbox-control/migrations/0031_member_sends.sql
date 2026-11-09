-- When each member last sent a message to a shared workspace, reported by the member's own
-- signed-in client (their Orca token, not the VM). The egress proxy honors a member's GitHub
-- identity only within a short window after this, so nothing inside the VM can push as a member
-- who is not actively driving the workspace.
CREATE TABLE workspace_member_sends (
  sandbox_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (sandbox_id, user_id)
);
