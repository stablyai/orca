SELECT
  event,
  min(timestamp) AS first_seen_utc,
  argMin(toString(properties.app_version), timestamp) AS first_seen_version,
  argMin(toString(properties.orca_channel), timestamp) AS first_seen_channel,
  uniq(toString(properties.app_version)) AS versions,
  count() AS events,
  uniq(distinct_id) AS installs,
  count() - uniq(tuple(distinct_id, if(event = 'meaningful_activity_day', formatDateTime(timestamp, '%Y-%m-%d'), ''))) AS duplicate_events,
  countIf(properties.sample_rate IS NOT NULL) AS events_with_sample_rate,
  countIf(if(event = 'first_agent_interaction', properties.source, properties.trigger) IS NULL) AS missing_source_or_trigger,
  countIf(properties.install_cohort IS NULL) AS missing_install_cohort,
  groupUniqArray(toString(if(event = 'first_agent_interaction', properties.source, properties.trigger))) AS source_or_trigger_values,
  groupUniqArray(toString(properties.agent_kind)) AS agent_kind_values,
  groupUniqArray(toString(properties.install_cohort)) AS install_cohort_values,
  groupUniqArray(coalesce(toString(properties.platform), 'unknown')) AS platforms
FROM events
WHERE event IN ('first_agent_interaction', 'meaningful_activity_day')
  AND timestamp >= toDateTime('2026-11-08 00:00:00')
  AND properties.install_id IS NOT NULL AND properties.orca_channel IS NOT NULL
GROUP BY event
