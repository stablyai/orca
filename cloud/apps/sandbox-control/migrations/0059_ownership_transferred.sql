-- OWNER-TRANSFER: a workspace handed to another owner is in shared mode for credentials from then
-- on (no personal secrets, personal agent accounts or owner-only git identity), because files the
-- previous owner left on its disk run again on wake. Set in the same write as the owner change and
-- never cleared; the new owner creates a fresh workspace to use personal credentials. Additive.
ALTER TABLE sandboxes ADD COLUMN ownership_transferred_at INTEGER;

-- Workspaces transferred before this existed: the owner is not who created it. Fail closed.
UPDATE sandboxes SET ownership_transferred_at = updated_at
 WHERE created_by IS NOT NULL AND created_by <> user_id AND status <> 'destroyed';
