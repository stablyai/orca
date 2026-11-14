import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'

export const completionTable = 'orchestration_presentation_completions'
export const completionState = 'orchestration_presentation_completion_state'

const operationNow = `(SELECT operation_now FROM ${completionState} WHERE id = 1)`
const expire = `DELETE FROM ${completionTable} WHERE epoch < ${operationNow} - ${AGENT_STATUS_STALE_AFTER_MS};`
const clock = `UPDATE ${completionState} SET operation_now = orchestration_presentation_now() WHERE id = 1;
  UPDATE ${completionState} SET recovery = recovery OR operation_now < stamp,
    stamp = operation_now WHERE id = 1; ${expire}`
const replace = `INSERT INTO ${completionTable}(id, epoch)
  SELECT NEW.id, epoch FROM (SELECT orchestration_completion_epoch(NEW.completed_at) AS epoch)
  WHERE NEW.status NOT IN ('pending', 'dispatched')
    AND epoch >= ${operationNow} - ${AGENT_STATUS_STALE_AFTER_MS};`

export const presentationCompletionSchema = `
  CREATE TEMP TABLE IF NOT EXISTS ${completionTable}(id TEXT PRIMARY KEY, epoch REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS temp.orchestration_presentation_completion_epoch ON ${completionTable}(epoch, id);
  CREATE TEMP TABLE IF NOT EXISTS ${completionState}(
    id INTEGER PRIMARY KEY CHECK(id = 1), ready INTEGER NOT NULL DEFAULT 0,
    version INTEGER, zone TEXT, stamp REAL NOT NULL DEFAULT 0,
    recovery INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
    operation_now REAL NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO ${completionState}(id) VALUES(1);
  CREATE TEMP TRIGGER IF NOT EXISTS orchestration_presentation_completion_insert
    AFTER INSERT ON main.dispatch_contexts BEGIN ${clock} ${replace} END;
  CREATE TEMP TRIGGER IF NOT EXISTS orchestration_presentation_completion_update
    AFTER UPDATE OF id, status, completed_at ON main.dispatch_contexts
    BEGIN ${clock} DELETE FROM ${completionTable} WHERE id = OLD.id; ${replace} END;
  CREATE TEMP TRIGGER IF NOT EXISTS orchestration_presentation_completion_delete
    AFTER DELETE ON main.dispatch_contexts
    BEGIN ${clock} DELETE FROM ${completionTable} WHERE id = OLD.id; END;`
