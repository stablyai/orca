#!/usr/bin/env bash
# Run one arm over the full suite and stop it the moment its subscription usage limit is hit.
# Usage: SEED=0 EFFORT=medium [CLAUDE_MODEL=...] evals/deepswe/run_until_limit.sh <agent> <job-name>
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EVAL_HOME="${DEEPSWE_EVAL_HOME:-$HOME/deepswe-eval}"
agent="$1"; job="$2"
JOB_DIR="$EVAL_HOME/jobs/$job"
LIMIT_RE='usage_limit_reached|hit your usage limit|usage limit reached'

"$HERE/run.sh" "$agent" "$job" all > "$EVAL_HOME/jobs/$job.log" 2>&1 &
RUN_PID=$!
echo "$(date '+%F %T') started $agent as $job (pid $RUN_PID)"

stop_job() {
  pkill -INT -f -- "--job-name $job( |$)" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$RUN_PID" 2>/dev/null || break; sleep 2; done
  pkill -KILL -f -- "--job-name $job( |$)" 2>/dev/null
  for t in "$JOB_DIR"/*/; do
    p=$(basename "$t")
    ids=$(docker ps -aq --filter "label=com.docker.compose.project=$p")
    [ -n "$ids" ] && docker rm -f $ids >/dev/null
  done
}

while kill -0 "$RUN_PID" 2>/dev/null; do
  hit=$(grep -lE "$LIMIT_RE" "$JOB_DIR"/*/agent/*.txt 2>/dev/null | head -1)
  if [ -n "$hit" ]; then
    echo "$(date '+%F %T') LIMIT_HIT in $(basename "$(dirname "$(dirname "$hit")")"); stopping $job"
    stop_job
    echo "$(date '+%F %T') stopped; leftover containers: $(for t in "$JOB_DIR"/*/; do docker ps -aq --filter "label=com.docker.compose.project=$(basename "$t")"; done | wc -l | tr -d ' ')"
    exit 0
  fi
  sleep 20
done
wait "$RUN_PID"; echo "$(date '+%F %T') $job finished without hitting the limit (exit $?)"
