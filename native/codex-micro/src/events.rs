use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ControlId {
    #[serde(rename = "AG00")]
    Ag00,
    #[serde(rename = "AG01")]
    Ag01,
    #[serde(rename = "AG02")]
    Ag02,
    #[serde(rename = "AG03")]
    Ag03,
    #[serde(rename = "AG04")]
    Ag04,
    #[serde(rename = "AG05")]
    Ag05,
    #[serde(rename = "ACT06")]
    Act06,
    #[serde(rename = "ACT07")]
    Act07,
    #[serde(rename = "ACT08")]
    Act08,
    #[serde(rename = "ACT09")]
    Act09,
    #[serde(rename = "ACT10")]
    Act10,
    #[serde(rename = "ACT11")]
    Act11,
    #[serde(rename = "ACT12")]
    Act12,
    #[serde(rename = "ENC_CC")]
    EncCc,
    #[serde(rename = "ENC_CW")]
    EncCw,
    #[serde(rename = "ENC_CLK")]
    EncClk,
}

impl ControlId {
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "AG00" => ControlId::Ag00,
            "AG01" => ControlId::Ag01,
            "AG02" => ControlId::Ag02,
            "AG03" => ControlId::Ag03,
            "AG04" => ControlId::Ag04,
            "AG05" => ControlId::Ag05,
            "ACT06" => ControlId::Act06,
            "ACT07" => ControlId::Act07,
            "ACT08" => ControlId::Act08,
            "ACT09" => ControlId::Act09,
            "ACT10" => ControlId::Act10,
            "ACT11" => ControlId::Act11,
            "ACT12" => ControlId::Act12,
            "ENC_CC" => ControlId::EncCc,
            "ENC_CW" => ControlId::EncCw,
            "ENC_CLK" => ControlId::EncClk,
            _ => return None,
        })
    }

    fn is_encoder_rotation(self) -> bool {
        matches!(self, ControlId::EncCc | ControlId::EncCw)
    }
}

/// Wire shape matches the shared TypeScript `CodexMicroInputEvent` contract
/// exactly (`{"kind":"control",...}` / `{"kind":"radar",...}`) so the sidecar
/// protocol never needs a translation layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeviceEvent {
    Control { control: ControlId, action: u8 },
    Radar { angle: f64, distance: f64 },
}

/// Decodes a complete `v.oai.hid` / `v.oai.rad` JSON object into a typed event.
/// Returns `None` for unknown controls, out-of-range actions, an action that
/// does not match the control's press/release-vs-step semantics, or
/// non-finite radar values — the caller must drop the event, not guess.
pub fn decode_event_json(value: &Value) -> Option<DeviceEvent> {
    let method = value.get("m")?.as_str()?;
    let params = value.get("p")?;

    match method {
        "v.oai.hid" => {
            let control = ControlId::from_wire(params.get("k")?.as_str()?)?;
            let action = params.get("act")?.as_u64()?;
            if action > 2 {
                return None;
            }
            let action = action as u8;
            let valid = if control.is_encoder_rotation() {
                action == 2
            } else {
                action == 0 || action == 1
            };
            if !valid {
                return None;
            }
            Some(DeviceEvent::Control { control, action })
        }
        "v.oai.rad" => {
            let angle = params.get("a")?.as_f64()?;
            let distance = params.get("d")?.as_f64()?;
            if !angle.is_finite() || !distance.is_finite() {
                return None;
            }
            Some(DeviceEvent::Radar { angle, distance })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_control_events_in_the_shared_contract_shape() {
        let event = DeviceEvent::Control {
            control: ControlId::Ag00,
            action: 1,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"kind": "control", "control": "AG00", "action": 1})
        );
    }

    #[test]
    fn serializes_radar_events_in_the_shared_contract_shape() {
        let event = DeviceEvent::Radar {
            angle: 0.5,
            distance: 1.0,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"kind": "radar", "angle": 0.5, "distance": 1.0})
        );
    }
}
