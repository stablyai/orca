locals {
  relay_service_names = concat(
    [var.relay_cloud_run_service_name],
    [for cell in values(var.relay_cells) : cell.service_name]
  )
  relay_service_log_filter = join(" OR ", [
    for name in local.relay_service_names : "resource.labels.service_name=\"${name}\""
  ])
  relay_runtime_log_filter = "((resource.type=\"cloud_run_revision\" AND (${local.relay_service_log_filter})) OR (resource.type=\"gce_instance\" AND jsonPayload.role=\"cell\")) AND jsonPayload.event=\"orca_relay_runtime_metrics\""
  relay_gce_connection_warning_thresholds = {
    for cell_id, cell in var.relay_gce_cells :
    cell_id => cell.connection_hard_cap == null ? 550 : floor(
      (cell.connection_hard_cap - 100 - cell.connection_unobserved_bound) * 0.85
    )
  }
  relay_gce_connection_warning_groups = {
    for threshold in distinct(values(local.relay_gce_connection_warning_thresholds)) :
    tostring(threshold) => sort([
      for cell_id, cell_threshold in local.relay_gce_connection_warning_thresholds :
      cell_id if cell_threshold == threshold
    ])
  }
  relay_incident_metrics = {
    assignment_5xx = {
      description = "Director assignment requests returning a server error."
      filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.relay_cloud_run_service_name}\" AND httpRequest.requestMethod=\"POST\" AND httpRequest.requestUrl=~\"/v1/assign$\" AND httpRequest.status>=500"
    }
    assignment_edge_429 = {
      description = "Director assignment or resolve requests rejected before an instance was available."
      filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.relay_cloud_run_service_name}\" AND httpRequest.requestMethod=\"POST\" AND httpRequest.requestUrl=~\"/v1/(assign|resolve)$\" AND httpRequest.status=429"
    }
    postgres_retries = {
      description = "Relay PostgreSQL transactions recovered after a retryable abort."
      filter      = "((resource.type=\"cloud_run_revision\" AND (${local.relay_service_log_filter})) OR resource.type=\"gce_instance\") AND jsonPayload.event=\"orca_relay_postgres_transaction_retry\""
    }
    postgres_retry_exhausted = {
      description = "Relay PostgreSQL transactions that exhausted bounded retry."
      filter      = "((resource.type=\"cloud_run_revision\" AND (${local.relay_service_log_filter})) OR resource.type=\"gce_instance\") AND jsonPayload.event=\"orca_relay_postgres_transaction_exhausted\""
    }
    cell_process_exit = {
      # The docker event stream is the only per-exit line: the relay's own crash footer only
      # appears for unhandled rejections, and `container start` also counts healthy first boots.
      description = "Relay cell container exits, one Docker `container die` event per process exit."
      filter      = "resource.type=\"gce_instance\" AND logName=\"projects/${var.project_id}/logs/cos_system\" AND jsonPayload.SYSLOG_IDENTIFIER=\"docker\" AND jsonPayload.MESSAGE:\"container die\" AND jsonPayload.MESSAGE:\"name=orca-relay)\""
    }
    cloud_sql_wal_checkpoint = {
      description = "Cloud SQL checkpoints triggered by WAL volume instead of the timed schedule; a sustained run is the fsync loop that stalled every relay process at once on 2026-09-04."
      filter      = "resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${var.project_id}:${local.relay_database_instance_name}\" AND textPayload:\"checkpoint starting: wal\""
    }
  }

  relay_runtime_metrics = {
    total_connections                  = { field = "totalConnections", description = "Open relay WebSocket requests per process." }
    controls                           = { field = "controls", description = "Authenticated standing desktop controls per process." }
    splices                            = { field = "splices", description = "Active phone-to-desktop ciphertext splices per process." }
    pending_splices                    = { field = "pendingSplices", description = "Phone connections waiting for their host data leg." }
    queued_bytes                       = { field = "queuedBytes", description = "Process-wide relay backpressure bytes." }
    http_latency_ms                    = { field = "httpLatencyMsMax", description = "Maximum director/administrative HTTP latency in the interval." }
    sql_latency_ms                     = { field = "sqlLatencyMsMax", description = "Maximum observed SQL operation latency in the interval." }
    control_renewal_latency_ms_p50     = { field = "controlRenewalLatencyMsP50", description = "Control renewal latency p50 in the interval." }
    control_renewal_latency_ms_p95     = { field = "controlRenewalLatencyMsP95", description = "Control renewal latency p95 in the interval." }
    control_renewal_latency_ms_max     = { field = "controlRenewalLatencyMsMax", description = "Maximum control renewal latency in the interval." }
    control_renewals                   = { field = "controlRenewalsDelta", description = "Control renewal attempts in the interval." }
    control_renewal_successes          = { field = "controlRenewalSuccessesDelta", description = "Successful control renewals in the interval." }
    control_renewal_lease_misses       = { field = "controlRenewalLeaseMissesDelta", description = "Control renewals that found their activity lease missing." }
    control_activity_recoveries        = { field = "controlActivityRecoveriesDelta", description = "Control activity leases recovered after a renewal miss." }
    control_activity_recovery_failures = { field = "controlActivityRecoveryFailuresDelta", description = "Control activity lease recovery attempts that failed." }
    control_rtt_ms_p50                 = { field = "controlRttMsP50", description = "Control-socket ping round trip p50 in the interval. The desktop echoes the pong on its main thread, so only the median reads as distance; the p95 and max below are dominated by desktop stalls." }
    control_rtt_ms_p95                 = { field = "controlRttMsP95", description = "Control-socket ping round trip p95 in the interval; a desktop-stall signal, not a distance one." }
    control_rtt_ms_max                 = { field = "controlRttMsMax", description = "Maximum control-socket ping round trip in the interval; a desktop-stall signal, not a distance one." }
    control_rtt_samples                = { field = "controlRttSamplesDelta", description = "Control-socket round trips observed in the interval, one per ping answered; the percentiles above are omitted when this is zero." }
    control_rtt_samples_dropped        = { field = "controlRttSamplesDroppedDelta", description = "Observed round trips the bounded percentile reservoir did not keep; non-zero means the percentiles above summarise a uniform sample of the interval." }
    client_accepts_completed           = { field = "clientAcceptCompletedDelta", description = "Phone accepts that reached relay-hello in the interval; the percentiles below are omitted when this is zero." }
    client_accept_total_ms_p50         = { field = "clientAcceptTotalMsP50", description = "Successful phone-accept duration p50, dial to relay-hello." }
    client_accept_total_ms_p95         = { field = "clientAcceptTotalMsP95", description = "Successful phone-accept duration p95, dial to relay-hello." }
    client_accept_total_ms_max         = { field = "clientAcceptTotalMsMax", description = "Maximum successful phone-accept duration in the interval." }
    client_accept_assignment_ms_p95    = { field = "clientAcceptAssignmentMsP95", description = "Accept stage p95: resume/invite lookup plus assignment resolve." }
    client_accept_credential_ms_p95    = { field = "clientAcceptCredentialMsP95", description = "Accept stage p95: outer credential reservation." }
    client_accept_activity_ms_p95      = { field = "clientAcceptActivityMsP95", description = "Accept stage p95: credential activity lease acquisition." }
    client_accept_attach_ms_p95        = { field = "clientAcceptAttachMsP95", description = "Accept stage p95: conn-open sent until the desktop's data leg authenticated." }
    client_accept_basis_ms_p95         = { field = "clientAcceptBasisMsP95", description = "Accept stage p95: splice lease and connection-basis writes between the data leg and relay-hello." }
    heap_used_bytes                    = { field = "heapUsedBytes", description = "Node.js heap bytes used by the relay process." }
    event_loop_ms_p99                  = { field = "eventLoopDelayMsP99", description = "Node.js event-loop delay p99 in milliseconds." }
    forwarded_bytes                    = { field = "forwardedBytesDelta", description = "Ciphertext bytes admitted for forwarding." }
    auth_successes                     = { field = "authSuccessesDelta", description = "Successful outer relay authentication stages." }
    auth_failures                      = { field = "authFailuresDelta", description = "Rejected or timed-out outer relay authentication stages." }
    reconnects                         = { field = "reconnectsDelta", description = "Desktop control rebinds or generation replacements." }
    sql_queries                        = { field = "sqlQueriesDelta", description = "Completed relay SQL operations." }
    sql_failures                       = { field = "sqlFailuresDelta", description = "Failed relay SQL operations." }
    db_pool_total                      = { field = "databasePoolTotal", description = "Open PostgreSQL connections in the process pool." }
    db_pool_idle                       = { field = "databasePoolIdle", description = "Idle PostgreSQL connections in the process pool." }
    db_pool_waiting                    = { field = "databasePoolWaiting", description = "Current requests queued for a PostgreSQL connection." }
    db_waiters_max                     = { field = "databasePoolWaitersMax", description = "Maximum requests queued for a PostgreSQL connection during the interval." }
    db_oldest_wait_ms                  = { field = "databasePoolOldestWaitMs", description = "Current oldest PostgreSQL pool waiter age." }
    db_wait_ms_max                     = { field = "databasePoolWaitMsMax", description = "Maximum PostgreSQL pool wait during the interval." }
  }

  # Regions the director can hint or select. Pinned to relay-contract's RELAY_REGIONS by
  # dev/scripts/relay-region-hint-metrics.test.mjs, which also checks the flat field names below
  # against the emitter. A region missing here drops out of both shares the skew alert compares.
  relay_region_keys = ["us-central1", "asia-east2"]
  # Flat emitter fields, not the nested `requestedRegionsDelta` map: a log-based metric would need
  # a quoted field path to reach a hyphenated map key, and the relay publishes these as zeros in
  # every interval so no series can drop out of the alert's inner join. Spelled out rather than
  # derived, so this literal and relay-contract's RELAY_REGION_METRIC_SEGMENTS can be compared
  # directly; reformatting either side cannot break the check and neither can drift alone.
  relay_region_field_segments = {
    "us-central1" = "UsCentral1"
    "asia-east2"  = "AsiaEast2"
  }
  relay_region_columns = { for key in local.relay_region_keys : key => replace(key, "-", "_") }
  relay_region_share_metrics = merge(
    {
      for key in local.relay_region_keys :
      "requested_regions_${local.relay_region_columns[key]}" => {
        field       = "requestedRegion${local.relay_region_field_segments[key]}Delta"
        description = "Assignment requests that hinted ${key}."
      }
    },
    {
      for key in local.relay_region_keys :
      "selected_regions_${local.relay_region_columns[key]}" => {
        field       = "selectedRegion${local.relay_region_field_segments[key]}Delta"
        description = "Assignments that placed a host in ${key}."
      }
    }
  )
  relay_region_hinted_total   = join(" + ", [for key in local.relay_region_keys : "req_${local.relay_region_columns[key]}"])
  relay_region_selected_total = join(" + ", [for key in local.relay_region_keys : "sel_${local.relay_region_columns[key]}"])
  # MQL, not a filter condition: every runtime metric is a DELTA DISTRIBUTION, and the only scalar
  # aligners a `condition_threshold` can apply to one are percentiles. Both shares need the sum of
  # the extracted values, which is `sum(value.<metric>)` in MQL and unreachable otherwise.
  relay_region_hint_skew_query = join("\n", concat(
    ["{"],
    flatten([
      for index, entry in [
        for key in local.relay_region_keys : { metric = "requested_regions_${local.relay_region_columns[key]}", column = "req_${local.relay_region_columns[key]}" }
        ] : [
        index == 0 ? "" : ";",
        "  fetch cloud_run_revision::logging.googleapis.com/user/orca_relay_${entry.metric}",
        "  | align delta(1h) | every 1h",
        "  | group_by [], [${entry.column}: sum(value.orca_relay_${entry.metric})]"
      ]
    ]),
    flatten([
      for key in local.relay_region_keys : [
        ";",
        "  fetch cloud_run_revision::logging.googleapis.com/user/orca_relay_selected_regions_${local.relay_region_columns[key]}",
        "  | align delta(1h) | every 1h",
        "  | group_by [], [sel_${local.relay_region_columns[key]}: sum(value.orca_relay_selected_regions_${local.relay_region_columns[key]})]"
      ]
    ]),
    [
      "}",
      "| join",
      "| value [",
      "    hint_share: req_asia_east2 / (${local.relay_region_hinted_total}),",
      "    placement_share: sel_asia_east2 / (${local.relay_region_selected_total}),",
      "    hinted_requests: ${local.relay_region_hinted_total}",
      "  ]",
      # Cross-multiplied, never a plain ratio of the two shares: an hour that placed nobody in the
      # region makes that ratio 0/0 or x/0, and MQL drops the row instead of yielding a number, so
      # the whole series vanishes before the other clauses run. That hour is the worst skew there
      # is - every desktop asking for a region the director is putting nobody in - and it happens
      # whenever the region is drained, fenced, or at capacity. Both forms were run read-only
      # against production surrogates with a zero denominator: the ratio returned no rows, this
      # returned the series with the condition true.
      "| condition hint_share > 2 * placement_share && hint_share - placement_share > 0.15 '1' && hinted_requests > 500 '1'"
    ]
  ))
  relay_custom_alerts = {
    connection_headroom = {
      pages_oncall = true
      metric       = "total_connections"
      # Live values, set by hand on 2026-08-05. The cell arm is ~85% of the 440 usable
      # connection units (600 hard cap - 100 rebind reserve - 60 unobserved bound); 800
      # exceeded the 600 cap outright and could never fire.
      threshold_run = 550
      threshold_gce = 374
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "A relay process is above its reviewed connection warning point; stop new assignment to the cell and follow the hot-cell runbook."
    }
    queue_pressure = {
      pages_oncall  = false
      metric        = "queued_bytes"
      threshold_run = 50331648
      threshold_gce = 50331648
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Process-wide queued ciphertext exceeded 75% of the 64 MiB hard budget. Investigate slow receivers before admission starts rejecting."
    }
    auth_failures = {
      pages_oncall  = false
      metric        = "auth_failures"
      threshold_run = 20
      threshold_gce = 20
      duration      = "0s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Outer authentication failures exceeded the per-process interval threshold. Check auth/JWKS health and abuse sources without logging bearer values."
    }
    reconnects = {
      pages_oncall  = false
      metric        = "reconnects"
      threshold_run = 100
      threshold_gce = 100
      duration      = "0s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Relay control reconnects exceeded the per-process interval threshold. Check revision churn, GFE terminations, and reconnect jitter."
    }
    sql_failures = {
      pages_oncall = true
      # Tuned live on 2026-08-05 to stop Slack alert noise; codified here so an apply cannot revert it.
      metric        = "sql_failures"
      threshold_run = 0
      threshold_gce = 0
      duration      = "300s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "A relay SQL operation failed. Check Cloud SQL availability, connection pressure, and transaction retry outcomes."
    }
    sql_latency = {
      pages_oncall  = false
      metric        = "sql_latency_ms"
      threshold_run = 500
      threshold_gce = 500
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Relay SQL operations remained above 500 ms. Inspect lock contention and Cloud SQL health before migrations or drains."
    }
    database_pool_waiters = {
      pages_oncall = true
      # Tuned live on 2026-08-05 to stop Slack alert noise; codified here so an apply cannot revert it.
      metric        = "db_waiters_max"
      threshold_run = 5
      threshold_gce = 5
      duration      = "300s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "A relay process queued work for a PostgreSQL connection. Check public-assignment admission, pool saturation, and Cloud SQL latency before scaling."
    }
    database_pool_wait = {
      pages_oncall = true
      # Tuned live on 2026-08-05 to stop Slack alert noise; codified here so an apply cannot revert it.
      metric        = "db_wait_ms_max"
      threshold_run = 500
      threshold_gce = 500
      duration      = "300s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "A relay process waited over 500 ms for a PostgreSQL connection. Check long transactions and lock contention before migrations or drains."
    }
    http_latency = {
      pages_oncall  = false
      metric        = "http_latency_ms"
      threshold_run = 2000
      threshold_gce = 2000
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Relay HTTP handling remained above two seconds. Check director assignment/resolve latency and SQL contention; WebSocket lifetimes are intentionally excluded."
    }
    heap_pressure = {
      pages_oncall  = false
      metric        = "heap_used_bytes"
      threshold_run = 419430400
      threshold_gce = 419430400
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Node.js heap stayed above 400 MiB on a 512 MiB container. Drain the affected cell and investigate connection or queue retention."
    }
    event_loop_delay = {
      pages_oncall  = false
      metric        = "event_loop_ms_p99"
      threshold_run = 250
      threshold_gce = 250
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Relay event-loop p99 delay stayed above 250 ms. Check CPU, SQL callbacks, synchronized heartbeats, and queue pressure."
    }
  }
}

resource "google_logging_metric" "relay_snapshot" {
  # Region-request metrics ride the same event and shape; merging adds map entries only, so the
  # existing metric instances are untouched (a label change, not a new key, is what recreates them).
  for_each = merge(local.relay_runtime_metrics, local.relay_region_share_metrics)

  project         = var.project_id
  name            = "orca_relay_${each.key}"
  description     = each.value.description
  filter          = local.relay_runtime_log_filter
  value_extractor = "EXTRACT(jsonPayload.${each.value.field})"
  label_extractors = {
    role    = "EXTRACT(jsonPayload.role)"
    cell_id = "EXTRACT(jsonPayload.cellId)"
    # No region label: adding one replaces all 42 live metrics (label change = delete+create),
    # which resets history and blanks the relay alert policies during the swap.
  }

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = contains(["sql_latency_ms", "control_rtt_ms_p50", "control_rtt_ms_p95", "control_rtt_ms_max", "client_accept_total_ms_p50", "client_accept_total_ms_p95", "client_accept_total_ms_max", "client_accept_assignment_ms_p95", "client_accept_credential_ms_p95", "client_accept_activity_ms_p95", "client_accept_attach_ms_p95", "client_accept_basis_ms_p95", "control_renewal_latency_ms_p50", "control_renewal_latency_ms_p95", "control_renewal_latency_ms_max", "http_latency_ms", "event_loop_ms_p99", "db_oldest_wait_ms", "db_wait_ms_max"], each.key) ? "ms" : each.key == "queued_bytes" || each.key == "heap_used_bytes" || each.key == "forwarded_bytes" ? "By" : "1"

    labels {
      key         = "role"
      value_type  = "STRING"
      description = "Relay process role."
    }

    labels {
      key         = "cell_id"
      value_type  = "STRING"
      description = "Durable relay cell identifier."
    }
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 24
      growth_factor      = 2
      scale              = 1
    }
  }
}

resource "google_logging_metric" "relay_incident" {
  for_each = local.relay_incident_metrics

  project     = var.project_id
  name        = "orca_relay_${each.key}"
  description = each.value.description
  filter      = each.value.filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "relay_custom" {
  for_each = local.relay_custom_alerts

  project      = var.project_id
  display_name = "Orca Relay: ${replace(each.key, "_", " ")}"
  combiner     = "OR"
  enabled      = true
  # Why: only the reviewed critical alerts page; the rest stay in the console. Applying one
  # list to every policy would have put the noisy ones back into Slack.
  notification_channels = each.value.pages_oncall ? var.relay_alert_notification_channels : []

  conditions {
    display_name = each.key

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/orca_relay_${each.value.metric}\""
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold_run
      duration        = each.value.duration

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = each.value.aligner
        cross_series_reducer = each.value.reducer
        group_by_fields      = ["resource.label.\"service_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  dynamic "conditions" {
    for_each = each.key == "connection_headroom" ? [] : [each.value]
    content {
      display_name = "${each.key} (GCE cell)"

      condition_threshold {
        filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/orca_relay_${conditions.value.metric}\""
        comparison      = "COMPARISON_GT"
        threshold_value = conditions.value.threshold_gce
        duration        = conditions.value.duration

        aggregations {
          alignment_period     = "300s"
          per_series_aligner   = conditions.value.aligner
          cross_series_reducer = conditions.value.reducer
          group_by_fields      = ["resource.label.\"instance_id\""]
        }

        trigger {
          count = 1
        }
      }
    }
  }

  documentation {
    content   = each.value.documentation
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_snapshot]
}

resource "google_monitoring_alert_policy" "relay_assignment_5xx" {
  project               = var.project_id
  display_name          = "Orca Relay: assignment 5xx"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "assignment 5xx"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/orca_relay_assignment_5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"service_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A desktop could not obtain a Relay assignment. Check PostgreSQL retry/exhaustion signals and director SQL latency; do not restart GCE cells or invalidate pairings."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_incident]
}

resource "google_monitoring_alert_policy" "relay_gce_connection_headroom" {
  for_each = local.relay_gce_connection_warning_groups

  project               = var.project_id
  display_name          = "Orca Relay: connection headroom (GCE ${each.key})"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "connection headroom (GCE ${each.key})"

    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/orca_relay_total_connections\" AND (${join(" OR ", [for cell_id in each.value : "metric.label.\"cell_id\"=\"${cell_id}\""])})"
      comparison      = "COMPARISON_GT"
      threshold_value = tonumber(each.key)
      duration        = "120s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.label.\"instance_id\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A Relay GCE cell is above 85% of its configured ordinary placement ceiling; stop new assignment to the cell and follow the hot-cell runbook."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_snapshot]
}

resource "google_monitoring_alert_policy" "relay_assignment_edge_429" {
  project               = var.project_id
  display_name          = "Orca Relay: assignment edge 429"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "assignment edge 429"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/orca_relay_assignment_edge_429\""
      comparison      = "COMPARISON_GT"
      threshold_value = 100
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"service_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Cloud Run rejected a sustained assignment burst before an instance was available. Check public-assignment admission, director concurrency, and database latency before scaling."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_incident]
}

resource "google_monitoring_alert_policy" "relay_postgres_retry_exhausted" {
  project               = var.project_id
  display_name          = "Orca Relay: PostgreSQL retry exhausted"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "PostgreSQL retry exhausted (Cloud Run)"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/orca_relay_postgres_retry_exhausted\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "180s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"service_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "PostgreSQL retry exhausted (GCE cell)"

    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/orca_relay_postgres_retry_exhausted\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "180s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"instance_id\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A Relay database transaction remained unsuccessful after bounded whole-transaction retry. Check Cloud SQL deadlocks/locks and customer-visible request failures before changing cell admission."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_incident]
}

resource "google_monitoring_alert_policy" "relay_cloud_sql_backends" {
  project      = var.project_id
  display_name = "Orca Relay: Cloud SQL connection headroom"
  combiner     = "OR"
  enabled      = true

  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "Cloud SQL backends above 320"

    condition_threshold {
      filter          = "resource.type=\"cloudsql_database\" AND resource.label.\"database_id\"=\"${var.project_id}:${local.relay_database_instance_name}\" AND metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\""
      comparison      = "COMPARISON_GT"
      threshold_value = 320
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Cloud SQL connections exceeded 80% of the 400-connection ceiling. Pause Relay pool or cell growth and inspect pool waits before the modeled 385-connection operating maximum is reached."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "relay_cloud_sql_checkpoint_loop" {
  project               = var.project_id
  display_name          = "Orca Relay: Cloud SQL checkpoint loop"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "WAL-triggered checkpoints above 3 in 5 minutes"

    condition_threshold {
      filter          = "resource.type=\"cloudsql_database\" AND metric.type=\"logging.googleapis.com/user/orca_relay_cloud_sql_wal_checkpoint\""
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Healthy operation is one timed checkpoint every 5 minutes. Repeated `checkpoint starting: wal` lines mean WAL is outrunning `max_wal_size` and every checkpoint fsync stalls all relay SQL for seconds. Check `checkpoint complete` sync= times and disk write throughput against the PD-SSD ceiling; the fix is disk size and `max_wal_size` in the Terraform root that owns the instance (orca-cloud `infra/terraform-foundation`)."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_incident]
}

resource "google_monitoring_alert_policy" "relay_cloud_sql_disk" {
  project               = var.project_id
  display_name          = "Orca Relay: Cloud SQL disk utilization"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "Cloud SQL disk above 70%"

    condition_threshold {
      filter          = "resource.type=\"cloudsql_database\" AND resource.label.\"database_id\"=\"${var.project_id}:${local.relay_database_instance_name}\" AND metric.type=\"cloudsql.googleapis.com/database/disk/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.7
      duration        = "600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "The shared auth/relay Cloud SQL disk is filling. `refresh_tokens` is the largest table and grows without pruning; grow the disk (IOPS scale with size) before it reaches the WAL checkpoint loop, and prune revoked token rows."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "relay_cloud_nat_port_drops" {
  count = local.relay_gce_configured ? 1 : 0

  project               = var.project_id
  display_name          = "Orca Relay: Cloud NAT port exhaustion"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "NAT packets dropped for lack of ports"

    condition_threshold {
      filter          = "resource.type=\"nat_gateway\" AND resource.label.\"gateway_name\"=monitoring.regex.full_match(\"${local.relay_gce_name}(-.*)?\") AND metric.type=\"router.googleapis.com/nat/dropped_sent_packets_count\" AND metric.label.\"reason\"=\"OUT_OF_RESOURCES\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "120s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"gateway_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Relay cells reach Cloud SQL's public IP through this NAT. Port exhaustion makes every cell's Cloud SQL Auth Proxy dial time out at once, which reads as a fleet-wide SQL stall with a healthy database. Check `nat/port_usage` per VM and raise `max_ports_per_vm` in `relay-gce-foundation.tf`, or move the database to a private IP."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "relay_cell_process_exit" {
  project               = var.project_id
  display_name          = "Orca Relay: cell process exits"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "Cell container exits above 3 in 15 minutes"

    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/orca_relay_cell_process_exit\""
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      duration        = "0s"

      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"instance_id\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A Relay GCE cell restarted its container more than three times in 15 minutes. Each exit drops every host and phone on that cell, and 201 exits went unpaged over 48 h on 2026-09-04. The instance hostname is `relay-<cell>-<suffix>`; read `jsonPayload.MESSAGE` on `cos_system` for the exit code and the container's own stderr for the stack before blaming MIG autoheal or load. A same-capacity roll is the remedy when the running image is behind."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_incident]
}

# Why: nothing fired while US desktops sat on asia-east2 cells for weeks in 2026-08. The two
# per-cell policies below read that as distance, and the fleet-wide one reads it as a bad region
# hint. All three are MQL because each needs the sum of a DELTA DISTRIBUTION as a volume floor,
# and the only scalar aligners a `condition_threshold` can apply to a distribution are percentiles.
# `join` is an inner join and the relay omits its percentile fields on an empty interval, so an
# idle cell drops out rather than alerting on nothing. The per-cell arms fetch `gce_instance`
# only: production runs no Cloud Run cells (`relay_cells` is empty), and a future one would need
# its own arm here. None of the metrics these query exist in the project yet, so what was checked
# against production is the query shape: the same MQL run over existing metrics of the same kind
# confirmed the distribution sum, the join arity, the unit literals, and the condition clause.
resource "google_monitoring_alert_policy" "relay_far_cell_accept_latency" {
  project               = var.project_id
  display_name          = "Orca Relay: far-cell phone accept latency"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "Phone accept p95 above 2 s for 15 minutes"

    condition_monitoring_query_language {
      # percentile(..., 50) over the window, not max: the published value is already a p95, so the
      # median of the interval p95s reads as sustained slowness instead of one bad 30-second flush.
      query    = <<-EOT
        {
          fetch gce_instance::logging.googleapis.com/user/orca_relay_client_accept_total_ms_p95
          | align delta(15m) | every 15m
          | group_by [metric.cell_id], [accept_p95_ms: percentile(value.orca_relay_client_accept_total_ms_p95, 50)]
        ;
          fetch gce_instance::logging.googleapis.com/user/orca_relay_client_accepts_completed
          | align delta(15m) | every 15m
          | group_by [metric.cell_id], [accepts: sum(value.orca_relay_client_accepts_completed)]
        }
        | join
        | condition accept_p95_ms > 2000 'ms' && accepts >= 20 '1'
      EOT
      duration = "0s"

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Phones on this cell are taking over two seconds to reach relay-hello. Measured separation: an in-region accept completes in 0.3-0.6 s and a cross-Pacific one in 5-10 s, so 2 s sits well outside in-region noise and well below the far-cell floor. The 20-accept floor over 15 minutes keeps a single slow accept on a quiet cell from paging. Check which regions the cell's hosts are actually in before touching capacity: the 2026-08 cause was desktops requesting the wrong region, not a slow cell. Read the per-stage `orca_relay_client_accept_*_ms_p95` metrics to separate distance from assignment, credential, or attach work."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_snapshot]
}

resource "google_monitoring_alert_policy" "relay_cell_control_rtt" {
  project               = var.project_id
  display_name          = "Orca Relay: cell control round trip"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "Control ping p50 above 150 ms for an hour"

    condition_monitoring_query_language {
      # p50 only. The desktop echoes the pong on its main thread, so the published p95 and max
      # track renderer stalls, not distance; the median is the only column that reads as distance.
      query    = <<-EOT
        {
          fetch gce_instance::logging.googleapis.com/user/orca_relay_control_rtt_ms_p50
          | align delta(1h) | every 1h
          | group_by [metric.cell_id], [control_rtt_p50_ms: percentile(value.orca_relay_control_rtt_ms_p50, 50)]
        ;
          fetch gce_instance::logging.googleapis.com/user/orca_relay_control_rtt_samples
          | align delta(1h) | every 1h
          | group_by [metric.cell_id], [samples: sum(value.orca_relay_control_rtt_samples)]
        }
        | join
        | condition control_rtt_p50_ms > 150 'ms' && samples >= 500 '1'
      EOT
      duration = "0s"

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "The median desktop on this cell is more than 150 ms away from it, which is a mis-homed population rather than a cell fault: an in-region control ping is tens of milliseconds and a US desktop on an asia-east2 cell is 200 ms or more. This is the signal that was missing while roughly 226 of 332 hosts on the asia cells were non-APAC for weeks in 2026-08. Confirm with the assignment table which regions those hosts requested, then rehome; do not restart or drain the cell on this alert alone. The 500-sample floor is about two continuously connected hosts at the 15-second control ping, so a nearly idle cell cannot alert on one desktop. Tuning risk: EU desktops on us-central1 sit at 100-130 ms, so a cell whose population is mostly European can approach 150 ms while correctly homed. Check where the hosts are before treating a first breach as mis-homing, and raise the bar only with that evidence."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_snapshot]
}

resource "google_monitoring_alert_policy" "relay_region_hint_skew" {
  project               = var.project_id
  display_name          = "Orca Relay: region hint skew"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "asia-east2 hint share above 2x its placement share for an hour"

    condition_monitoring_query_language {
      query    = local.relay_region_hint_skew_query
      duration = "0s"

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Desktops are asking the director for asia-east2 far more often than the director actually places them there, which is what silently homed US desktops on asia cells through 2026-08. The alert compares two shares of the same hour and never an absolute share, because an absolute bar is wrong at both ends: measured over twelve hours on 2026-09-07, while the desktop region probe was still mis-picking, asia-east2 was 33.8% of the 33,800 hinted requests but only 7.9% of the 45,364 assignments, and once the probe is fixed the genuine APAC share will climb past any fixed bar that would have caught this. Divergence was 4.27x with a 25.9-point gap, so the 2x and 15-point bars sit well inside the broken state and well outside a healthy one. `unhinted` requests are excluded from the denominator: they were 27% of all requests, and a client change that always sends a hint would move this number without any behaviour changing. Expect this to stay lit until the mis-homed backlog is rehomed, because sticky assignment never re-consults the hint, so a desktop already on an asia cell keeps being placed there no matter what it now asks for. Investigate the desktop region probe first, not relay placement."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_snapshot]
}

# Why: the four signals that had to be assembled by hand during the 2026-09-04 incident.
resource "google_monitoring_dashboard" "relay_incident" {
  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "Orca Relay: incident overview"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          xPos   = 0
          yPos   = 0
          width  = 3
          height = 4
          widget = {
            title = "Cloud SQL WAL checkpoints"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/orca_relay_cloud_sql_wal_checkpoint\" AND resource.type=\"cloudsql_database\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_SUM"
                      crossSeriesReducer = "REDUCE_SUM"
                    }
                  }
                }
              }]
              yAxis = {
                label = "checkpoints"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          xPos   = 3
          yPos   = 0
          width  = 3
          height = 4
          widget = {
            title = "Cloud NAT dropped packets"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"router.googleapis.com/nat/dropped_sent_packets_count\" AND resource.type=\"nat_gateway\" AND resource.label.\"gateway_name\"=monitoring.regex.full_match(\"${local.relay_gce_name}(-.*)?\")"
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_SUM"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.\"gateway_name\"", "metric.label.\"reason\""]
                    }
                  }
                }
              }]
              yAxis = {
                label = "packets"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          xPos   = 6
          yPos   = 0
          width  = 3
          height = 4
          widget = {
            title = "Auth refresh 401s"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/orca_auth_refresh_401\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_SUM"
                      crossSeriesReducer = "REDUCE_SUM"
                    }
                  }
                }
              }]
              yAxis = {
                label = "rejections"
                scale = "LINEAR"
              }
            }
          }
        },
        {
          xPos   = 9
          yPos   = 0
          width  = 3
          height = 4
          widget = {
            title = "Standing desktop controls (fleet sum)"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    # ALIGN_MEAN, not ALIGN_SUM: each process reports its standing control count once per interval.
                    filter = "metric.type=\"logging.googleapis.com/user/orca_relay_controls\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_MEAN"
                      crossSeriesReducer = "REDUCE_SUM"
                    }
                  }
                }
              }]
              yAxis = {
                label = "controls"
                scale = "LINEAR"
              }
            }
          }
        }
      ]
    }
  })

  depends_on = [google_logging_metric.relay_incident, google_logging_metric.relay_snapshot]
}
